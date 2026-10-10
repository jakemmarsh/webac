/**
 * FAITHFUL.422 → BUG.duplicate-local-sounds (2026-09-28) — opening and
 * closing a container plays NO local chime.
 *
 * FAITHFUL.422 wired GameUI.playOpenSound (Sound.Open on ViewContents) and
 * playCloseSound (Sound.Close on hiding the panel). The retail client has no
 * such calls: its own sounds are only the teleport tunnel's UI_EnterPortal /
 * UI_ExitPortal, the admin Environs sounds and three UI_ButtonPress layout
 * media (audio/RetailLocalSounds); a chest's lid sounds are its own On/Off
 * motion's animation hooks, and ACE sends no Open/Close Sound message
 * (PKModifier.cs:174 notes the pcaps' Open "makes no sound").
 *
 * Behavioral: the real GameUI in happy-dom with a recording soundPlayer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Sound } from '@ac/shared';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { isRetailClientLocalSound } from '../packages/renderer/src/audio/RetailLocalSounds.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('container open / close is silent (BUG.duplicate-local-sounds, behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const played: unknown[][] = [];
  const IDS = [0x10000063, 0x10000064, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) { const el = domWindow.document.createElement('div'); root.appendChild(el); elements.set(id, el); }
        return { root, elements, setText: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); }, destroy: () => { root.remove(); } };
      },
      // CORE.17.k.b.b.c.c.a.a.c.a — the strip renders as the dock's container slot.
      render: (layoutId: number, parent: HTMLElement) => ui.layoutRenderer.renderPanel(layoutId, parent),
    };
    ui.soundPlayer = { playGameSound: (...args: unknown[]) => { played.push(args); } };
    ui.audioManager = null;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('showing and hiding an open panel plays nothing, and resets the panel state', () => {
    played.length = 0;
    ui.showContainerPanel(0x80001234, [{ guid: 1, name: 'Apple', iconDid: 0, stackSize: 1 }]);
    expect(ui.isContainerOpen).toBe(true);
    ui.hideContainerPanel();
    expect(played).toEqual([]);
    expect(ui.isContainerOpen).toBe(false);
    expect(ui.openContainerGuid).toBe(0);
    expect(ui.containerItems).toEqual([]);
  });

  it('the Open / Close wrappers are gone and the sounds are not retail client-local', () => {
    expect(ui.playOpenSound).toBeUndefined();
    expect(ui.playCloseSound).toBeUndefined();
    expect(isRetailClientLocalSound(Sound.Open)).toBe(false);
    expect(isRetailClientLocalSound(Sound.Close)).toBe(false);
    ui.playUISound(Sound.Close);
    expect(played).toEqual([]);
  });
});
