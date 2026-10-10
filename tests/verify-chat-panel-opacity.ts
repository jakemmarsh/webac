/**
 * VISUAL3.2 / CORE.17.h — main chat window opacity (behavioral).
 *
 * VISUAL3.2 found the chat chrome rendered as an opaque black slab; CORE.17.h
 * closes the loop with the decompiled EoL client's actual numbers:
 *  - ChatInterface::ChatInterface @ 004f4550 seeds default 0.5 / active 1.0
 *    (the floaty windows 1-4 keep these — gmFloatyChatUI::Create @ 004ce2c0
 *    only calls that constructor);
 *  - gmMainChatUI::gmMainChatUI @ 004cd0f0 then pins the MAIN window's
 *    default AND current opacity to 1.0: the main window is fully opaque and
 *    its see-through message area is nothing but the baked alpha of the
 *    48x48 tile 0x06004cc2 (uniform black, alpha 175/255);
 *  - the PlayerModule options 0x10000080/81 apply only when present
 *    (gmFloatyMainChatUI::UpdateFromPlayerModule @ 004d2970 InqOptions each);
 *  - ChatInterface::SetOpacity @ 004f3120 pushes the value into the window's
 *    OWN render object (UISurfaceObject::SetMaterialOpacity @ 00694120), so
 *    the whole window blends — chrome and text alike — which CSS `opacity`
 *    on the window root reproduces.
 *
 * Drives the real GameUI.renderHUD() + focus/blur wiring + the server
 * options path. getTextureDataURLWithAlpha's pixel math is not exercised
 * here (happy-dom has no canvas 2D context — see verify-context-menu-
 * bitmap-font.ts); the fake records the multiplier it was asked for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// CORE.17.g — the main chat is the EoL window 0x2100006f (root 0x10000600,
// 410x100). Its background-bearing elements per the parsed DAT tree:
//   0x10000010 (5,5) 400x73 message area, 48x48 tile 0x06004cc2 (repeated)
//     0x10000011 (16,0) 368x73 text content — no media of its own
//     0x10000012 (384,0) 16x73 scrollbar column
//   0x10000013 (5,78) 400x17 input row, strip 0x0600113a (stretched)
//   0x10000014 Chat button / 0x10000016 entry / 0x10000019 Send
const BG_ELEMENT_IDS = { textArea: 0x10000010, inputRow: 0x10000013 };
const BORDER_ELEMENT_ID = 0x10000694;

describe('VISUAL3.2 / CORE.17.h — main chat window opacity (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const alphaCalls: Array<{ textureId: number; alpha: number }> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);

    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      if (layoutId === 0x2100006f) {
        for (const id of [
          0x10000600, BORDER_ELEMENT_ID, BG_ELEMENT_IDS.textArea,
          0x10000011, BG_ELEMENT_IDS.inputRow, 0x10000014, 0x10000016, 0x10000019,
        ]) {
          const el = domWindow.document.createElement('div');
          el.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(el);
          elements.set(id, el);
        }
      }
      return {
        root, elements, descs: new Map(),
        setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: (textureId: number, alpha: number) => {
        alphaCalls.push({ textureId, alpha });
        return `fake://tex-${textureId.toString(16)}-a${alpha}`;
      },
    };
    ui.renderHUD();
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function bgEl(id: number): HTMLElement {
    return ui.chatHandle.elements.get(id) as HTMLElement;
  }
  function rootOpacity(): number {
    const v = (ui.chatHandle.root as HTMLElement).style.opacity;
    return v === '' ? 1 : parseFloat(v);
  }
  function chatInput(): HTMLInputElement {
    const input = domWindow.document.getElementById('chat-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    return input;
  }

  it('paints the DAT backing art at its own alpha (multiplier 1) — the tile 0x06004cc2 supplies the see-through look', () => {
    expect(bgEl(BG_ELEMENT_IDS.textArea).style.backgroundImage).toContain('tex-6004cc2-a1');
    expect(bgEl(BG_ELEMENT_IDS.inputRow).style.backgroundImage).toContain('tex-600113a-a1');
    expect(alphaCalls.every((c) => c.alpha === 1)).toBe(true);
  });

  it('CORE.17.g — the 48x48 message tile repeats at native size; the input strip stretches', () => {
    expect(bgEl(BG_ELEMENT_IDS.textArea).style.backgroundSize).toBe('48px 48px');
    expect(bgEl(BG_ELEMENT_IDS.textArea).style.backgroundRepeat).toBe('repeat');
    expect(bgEl(BG_ELEMENT_IDS.inputRow).style.backgroundSize).toBe('100% 100%');
    expect(bgEl(BG_ELEMENT_IDS.inputRow).style.backgroundRepeat).toBe('no-repeat');
  });

  it('no per-element opacity is left on the backing elements or the border chrome', () => {
    expect(bgEl(BG_ELEMENT_IDS.textArea).style.opacity).toBe('');
    expect(bgEl(BG_ELEMENT_IDS.inputRow).style.opacity).toBe('');
    expect(bgEl(BORDER_ELEMENT_ID).style.backgroundImage).toBe('');
    expect(bgEl(BORDER_ELEMENT_ID).style.opacity).toBe('');
  });

  it('CORE.17.h — with no PlayerModule option the main window is fully opaque, focused or not (gmMainChatUI ctor 1.0/1.0)', () => {
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(false);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(false);
    expect(rootOpacity()).toBe(1);
    chatInput().dispatchEvent(new domWindow.Event('focus'));
    expect(rootOpacity()).toBe(1);
    chatInput().dispatchEvent(new domWindow.Event('blur'));
    expect(rootOpacity()).toBe(1);
  });

  it('CORE.17.h — the 20-tick fade (ListenToGlobalMessage @ 004f3840) is a 333ms linear opacity transition on the window root', () => {
    expect((ui.chatHandle.root as HTMLElement).style.transition).toBe('opacity 333ms linear');
  });

  it('CORE.17.h — the server blob\'s 0x10000080 dims the WHOLE window while unfocused; 0x10000081 applies while the entry has focus', () => {
    ui.setServerChatWindowOptions({ defaultOpacity: 0.5, activeOpacity: 0.9, chatWindows: new Map() });
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(50);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(90);
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(true);
    expect(rootOpacity()).toBeCloseTo(0.5, 5);
    chatInput().dispatchEvent(new domWindow.Event('focus'));
    expect(rootOpacity()).toBeCloseTo(0.9, 5);
    chatInput().dispatchEvent(new domWindow.Event('blur'));
    expect(rootOpacity()).toBeCloseTo(0.5, 5);
    // Whole-window: the backing art is untouched (no re-bake at 0.5).
    expect(bgEl(BG_ELEMENT_IDS.textArea).style.backgroundImage).toContain('a1');
    expect(bgEl(BG_ELEMENT_IDS.textArea).style.opacity).toBe('');
  });

  it('CORE.17.h — only 0x10000081 set: SetActiveOpacity lowers the main default to match (default <= active)', () => {
    ui.setServerChatWindowOptions({ activeOpacity: 0.3, chatWindows: new Map() });
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(false);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(true);
    expect(ui.mainChatOpacityState()).toEqual({ defaultOpacity: 0.3, activeOpacity: 0.3 });
    expect(rootOpacity()).toBeCloseTo(0.3, 5);
  });

  it('CORE.17.h — a blob without either option restores the constructor state (fully opaque main window)', () => {
    ui.setServerChatWindowOptions({ chatWindows: new Map() });
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(false);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(false);
    expect(rootOpacity()).toBe(1);
    expect(ui.floatyChatOpacityState()).toEqual({ defaultOpacity: 0.5, activeOpacity: 1 });
  });

  it('CORE.17.h — the GameplayOptions blob carries 0x10000080/81 only once set (never the floaty ctor 0.5 by default)', () => {
    let data = ui.buildChatWindowOptionsData();
    expect(data.defaultOpacity).toBeUndefined();
    expect(data.activeOpacity).toBeUndefined();
    ui.setServerChatWindowOptions({ defaultOpacity: 0.25, chatWindows: new Map() });
    data = ui.buildChatWindowOptionsData();
    expect(data.defaultOpacity).toBeCloseTo(0.25, 5);
    expect(data.activeOpacity).toBeUndefined();
    ui.setServerChatWindowOptions({ chatWindows: new Map() });
  });

  // CORE.17.h.b — retail's opacity gate is element ACTIVATION, and the entry's
  // own key handling drives it:
  //  - ChatInterface::IsTextEntryFocused @ 004f30a0: the manager's active
  //    element is the chat root AND the root's focus descendant is the entry;
  //  - HandleEnterKey @ 004f52d0: with PlayerModule::StayInChatMode false it
  //    calls entry->RelinquishFocus (vtable +0x108) + entry->Deactivate
  //    (+0x100) BEFORE ProcessCommand; DeactivateChatEntry @ 004f2fc0 (action
  //    0x27, Escape) does the same pair;
  //  - UIElement::Deactivate @ 00461d50 on a non-activatable child forwards to
  //    the ROOT window, whose Deactivate runs ActivationAlert(root,false) @
  //    0045c460 (m_activeElement = null) and broadcasts 0x2a / 0x2f;
  //  - ChatInterface::ListenToElementMessage @ 004f51c0 turns 0x29/0x2a/0x2f
  //    on the entry into RegisterForGlobalMessage(3) — the fade tick
  //    (ListenToGlobalMessage @ 004f3840) toward active-or-default;
  //  - UIElementManager::MouseDownEvent @ 0045db60: a click over NO element
  //    (the world) deactivates the active element; a click on another root
  //    activates that one (ActivationAlert swaps and deactivates the old).
  // So the entry losing focus IS retail's inactive transition — Send with
  // stay-in-chat off, Escape, a world click and a panel click all dim.
  function keydown(input: HTMLInputElement, key: string): void {
    input.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  }

  it('CORE.17.h.b — Enter with Stay-in-chat-mode OFF relinquishes the entry (HandleEnterKey @ 004f52d0) and the window returns to the inactive level', () => {
    ui.setServerChatWindowOptions({ defaultOpacity: 0.5, activeOpacity: 1, chatWindows: new Map() });
    ui.optionsSettings.stayInChatMode = false;
    const input = chatInput();
    input.focus();
    expect(domWindow.document.activeElement).toBe(input);
    expect(rootOpacity()).toBe(1);
    input.value = 'hello Dereth';
    keydown(input, 'Enter');
    expect(input.value).toBe('');
    expect(domWindow.document.activeElement).not.toBe(input);
    expect(rootOpacity()).toBeCloseTo(0.5, 5);
  });

  it('CORE.17.h.b — Enter with Stay-in-chat-mode ON keeps the entry focused (PlayerModule::StayInChatMode gate) so the active level persists', () => {
    ui.optionsSettings.stayInChatMode = true;
    const input = chatInput();
    input.focus();
    expect(rootOpacity()).toBe(1);
    input.value = 'still here';
    keydown(input, 'Enter');
    expect(input.value).toBe('');
    expect(domWindow.document.activeElement).toBe(input);
    expect(rootOpacity()).toBe(1);
    ui.optionsSettings.stayInChatMode = false;
  });

  it('CORE.17.h.b — Escape (action 0x27 -> DeactivateChatEntry @ 004f2fc0) drops the window to the inactive level', () => {
    const input = chatInput();
    input.focus();
    expect(rootOpacity()).toBe(1);
    keydown(input, 'Escape');
    expect(domWindow.document.activeElement).not.toBe(input);
    expect(rootOpacity()).toBeCloseTo(0.5, 5);
  });

  it('CORE.17.h.b — focus moving to another element (MouseDownEvent @ 0045db60 activates that root / deactivates the chat) dims; re-activating the entry restores the active level', () => {
    const other = domWindow.document.createElement('input');
    domWindow.document.body.appendChild(other);
    const input = chatInput();
    input.focus();
    expect(rootOpacity()).toBe(1);
    other.focus();
    expect(domWindow.document.activeElement).toBe(other);
    expect(rootOpacity()).toBeCloseTo(0.5, 5);
    input.focus();
    expect(rootOpacity()).toBe(1);
    other.blur();
    input.blur();
    other.remove();
    expect(rootOpacity()).toBeCloseTo(0.5, 5);
    ui.setServerChatWindowOptions({ chatWindows: new Map() });
    expect(rootOpacity()).toBe(1);
  });
});
