/**
 * "In Portal Space - Please Wait..." — where retail shows it.
 *
 * History: GAP.81 (2026-07-20) removed a hand-positioned top-centre label
 * and moved the string INTO the chat scroll, reading `ClientCommunication
 * System::RecvNotice_DisplayStringInfo → ClientSystem::AddTextToScroll` as
 * "a plain chat-log line". CORE.17.k (2026-09-09) re-traced the same path
 * one hop further (reference/client-eol/decomp/acclient-decompiled.c):
 *
 *  - AddTextToScroll @ 00563c50 special-cases text type 0x1a (no timestamp,
 *    no log file) and re-broadcasts DisplayFinalStringInfo(0x1a, ...).
 *  - ChatInterface::ChatInterface @ 004f4550 clears exactly bit 0x1a from
 *    every chat window's filter (`&= 0xfbffffff`), and
 *    RecvNotice_DisplayFinalStringInfo @ 004f4640 drops untargeted text
 *    whose type is not active — so no chat window shows it by default.
 *  - gmSpewBoxUI::RecvNotice_DisplayFinalStringInfo @ 004d60a0 accepts
 *    exactly type 0x1a: the notice is a SPEW-BOX line over the 3D view
 *    (layout 0x21000011, 450x72 centred 20px from the top, red, 5 s).
 *
 * So the string is neither an invented positioned label (GAP.81 was right
 * about the removed AC_COLORS.loadingText token) nor a chat line (GAP.81
 * was wrong about that). This file keeps the still-valid GAP.81 pins and
 * asserts the corrected routing behaviourally against the real GameUI in
 * happy-dom; the spew box itself is covered in verify-core17k-spew-box.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';
import { AC_COLORS, GameUI } from '../packages/renderer/src/ui/GameUI.js';
import { ZLayer } from '../packages/renderer/src/ui/ZIndexRegistry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GAP.81 pins that still hold', () => {
  it('the discredited loadingText AC_COLORS token stays gone (no hand-positioned label to colour)', () => {
    expect(AC_COLORS).not.toHaveProperty('loadingText');
  });

  it('loadingBg (the 3D-canvas backing fill, unrelated to the removed label) still exists', () => {
    expect(AC_COLORS.loadingBg).toBe('#000000');
  });

  it('showPortalSpace/hidePortalSpace/displayErrorText remain on the shipped class', () => {
    expect('showPortalSpace' in GameUI.prototype).toBe(true);
    expect('hidePortalSpace' in GameUI.prototype).toBe(true);
    expect('displayErrorText' in GameUI.prototype).toBe(true);
  });
});

describe('CORE.17.k — the portal-space notice is a spew-box line, not a chat line (happy-dom, real GameUI)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  function makeUI() {
    // One UI per document: GameUI resolves #chat-messages via document.getElementById.
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    // Permissive layout stub (as tests/verify-multiline-system-chat.ts) so
    // renderHUD builds the main chat window and its #chat-messages log.
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) { el = domWindow.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
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
    ui.getTexURL = () => null;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.showGame();
    return { ui, container };
  }

  it('showPortalSpace() puts the string in #hud-spew-box and NOT in #chat-messages', () => {
    const { ui, container } = makeUI();
    // The notice comes from the first UseTime pass (a new roll segment).
    ui.showPortalSpace(); ui.teleportTick(performance.now() / 1000);
    const spew = container.querySelector('#hud-spew-box') as HTMLElement;
    expect(spew).toBeTruthy();
    expect(spew.textContent).toContain('In Portal Space - Please Wait...');
    const chat = container.querySelector('#chat-messages') as HTMLElement;
    expect(chat).toBeTruthy();
    expect(chat.textContent ?? '').not.toContain('In Portal Space');
    ui.hidePortalSpace();
  });

  it('BUG.portal-tunnel-hides-hud — the tunnel covers the world only: the HUD (spew strip included) paints over it', () => {
    const { ui, container } = makeUI();
    ui.showPortalSpace(); ui.teleportTick(performance.now() / 1000);
    const tunnel = domWindow.document.getElementById('portal-space-tunnel') as HTMLElement;
    expect(tunnel).toBeTruthy();
    expect(tunnel).toBe(ui.portalSpaceOverlay);
    expect(ui.portalSpaceCovering).toBe(true);
    const hud = domWindow.document.getElementById('game-hud') as HTMLElement;
    expect(hud).toBeTruthy();
    expect(hud.style.display).toBe('block');
    // Both are position:fixed siblings in the root stacking context, so
    // their z-index alone decides the paint order.
    const zTunnel = Number(tunnel.style.zIndex);
    const zHud = Number(hud.style.zIndex);
    expect(tunnel.parentElement).toBe(domWindow.document.body);
    expect(zTunnel).toBeGreaterThan(ZLayer.GAME_CANVAS);
    expect(zTunnel).toBeLessThan(zHud);
    // The notice shows on the one HUD strip; no mirrored copy on the tunnel.
    expect(domWindow.document.getElementById('portal-spew-box')).toBeNull();
    const spew = container.querySelector('#hud-spew-box') as HTMLElement;
    expect(hud.contains(spew)).toBe(true);
    expect(spew.textContent).toContain('In Portal Space - Please Wait...');
    expect(tunnel.querySelector('.spew-item')).toBeNull();
    ui.hidePortalSpace();
    expect(domWindow.document.getElementById('portal-space-tunnel')).toBeNull();
    expect(ui.portalSpaceCovering).toBe(false);
  });

  it('a second teleport does not stack a duplicate line — retail replaces an identical top item', () => {
    const { ui, container } = makeUI();
    ui.showPortalSpace(); ui.teleportTick(performance.now() / 1000);
    ui.showPortalSpace(); ui.teleportTick(performance.now() / 1000 + 0.001);
    const rows = container.querySelectorAll('#hud-spew-box .spew-item');
    expect(rows.length).toBe(1);
    ui.hidePortalSpace();
  });

  it('with Chat Options > Errors ticked the same notice ALSO reaches the main chat window (bit 0x1a)', () => {
    const { ui, container } = makeUI();
    ui.optionsSettings.chatMainWindowErrors = true;
    ui.showPortalSpace(); ui.teleportTick(performance.now() / 1000);
    const chat = container.querySelector('#chat-messages') as HTMLElement;
    expect(chat.textContent).toContain('In Portal Space - Please Wait...');
    ui.hidePortalSpace();
  });
});
