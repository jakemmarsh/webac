/**
 * FAITHFUL.255 + CORE.5.b — HUD indicator strip (behavioral).
 *
 * FAITHFUL.255 added the generic `setIndicatorActive(id, active)` helper
 * that swaps an indicator between its active/inactive DAT textures with
 * per-id de-dup. CORE.5.b moved the indicators from the classic statusbar's
 * right-aligned row into the EoL floaty indicator strip (root-HUD child
 * 0x10000611, base layout 0x21000071, 150x30 top-left) AND corrected the
 * FAITHFUL.255/256/259/274-era role guesses against the decompiled
 * client's element-class registrations:
 *   0x100000f8 gmUIElement_LinkStatusIndicator  → 'connection'/'server-load'
 *              folded tri-state (green 0x06007498 / yellow 0x06007499 /
 *              red 0x0600749a)
 *   0x100000f5 gmUIElement_EffectsIndicator p=1 → 'effects-beneficial'
 *   0x100000f6 gmUIElement_EffectsIndicator p=2 → 'effects-harmful'
 *   0x100000f4 gmUIElement_VitaeIndicator       → 'vitae'
 *   0x100000f7 gmUIElement_BurdenIndicator      → 'burden'
 *   0x100000f3 gmUIElement_MiniGameIndicator    → 'minigame'
 *   0x100000fa logout X button (gmIndicatorsUI::ListenToElementMessage
 *              @ 004bfa90 → CM_UI::SendNotice_EndCharacterSession(1))
 * There is NO combat-toggle, pk-status, peace-war, logging or fellowship
 * indicator in the EoL strip.
 *
 * Drives the REAL renderHUD in happy-dom with a stub layout handle that
 * mirrors the 0x21000071 element structure, then asserts the DOM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Strip icon elements authored in layout 0x21000071 (each 20x20).
const STRIP_ELEMENT_IDS = [
  0x100000f3, 0x100000f4, 0x100000f5, 0x100000f6,
  0x100000f7, 0x100000f8, 0x100000fa,
];

describe('CORE.5.b — indicator strip + setIndicatorActive (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let logoutFired = 0;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container, { onLogout: () => { logoutFired++; } });

    // Seed texture URLs for the strip's texture set so texBgStyle resolves
    // real values.
    for (const tex of [
      0x06007498, 0x06007499, 0x0600749a, 0x0600749c, 0x0600749d,
      0x0600749e, 0x0600749f, 0x060074a0, 0x060074a1, 0x060074a2,
      0x060074a3, 0x060074a5, 0x060074a6, 0x060074b1, 0x060074b2,
    ]) {
      ui.uiTextures.set(tex, `fake://tex-${tex.toString(16)}`);
    }

    // Stub layout renderer: layout 0x21000071 gets the strip's icon
    // elements; everything else renders an empty permissive handle.
    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      if (layoutId === 0x21000071) {
        for (const id of STRIP_ELEMENT_IDS) {
          const icon = domWindow.document.createElement('div');
          icon.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(icon);
          elements.set(id, icon);
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
    };
    ui.renderHUD();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('renders the strip window at the authored top-left position (150x30)', () => {
    const strip = ui.hudContainer.querySelector('#hud-indicators') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(strip.style.top).toBe('0px');
    expect(strip.style.left).toBe('0px');
    expect(strip.style.width).toBe('150px');
    expect(strip.style.height).toBe('30px');
  });

  it('registers exactly the 6 role-corrected indicators (no invented server-load state)', () => {
    const ids = [...ui.indicatorTexById.keys()].sort();
    expect(ids).toEqual([
      'burden', 'connection', 'effects-beneficial', 'effects-harmful',
      'minigame', 'vitae',
    ]);
    expect(ui.indicatorActive.has('server-load')).toBe(false);
  });

  it('vitae is element 0x100000f4 with the lit/dark vitae art', () => {
    const vitae = domWindow.document.getElementById('hud-indicator-vitae') as HTMLElement;
    expect(vitae).toBeTruthy();
    expect(vitae.getAttribute('data-element-id')).toBe('0x100000f4');
    expect(vitae.style.backgroundImage).toContain('60074a1'); // dark by default
    ui.setIndicatorActive('vitae', true);
    expect(vitae.style.backgroundImage).toContain('60074a0'); // lit
    ui.setIndicatorActive('vitae', false);
    expect(vitae.style.backgroundImage).toContain('60074a1');
  });

  it('setIndicatorActive de-dupes same-state calls (FAITHFUL.255)', () => {
    ui.setIndicatorActive('minigame', true);
    const mg = domWindow.document.getElementById('hud-indicator-minigame') as HTMLElement;
    mg.style.backgroundImage = 'url(sentinel)';
    // Same state again — must not touch the DOM.
    ui.setIndicatorActive('minigame', true);
    expect(mg.style.backgroundImage).toContain('sentinel');
    ui.setIndicatorActive('minigame', false);
    expect(mg.style.backgroundImage).toContain('60074a6');
  });

  it('connection drives the LinkStatus element; server-load no longer does (CORE.17.k retail 4-state model)', () => {
    // CORE.17.k: 0x100000f8 is gmUIElement_LinkStatusIndicator — its state is
    // the seconds since the last server packet (green ≤5 s / yellow ≤20 s /
    // red ≤40 s / red-lost), never ping latency. The CORE.5.b "fold" of
    // 'server-load' into a yellow state was a wrong-premise reading; see
    // tests/verify-core17k-link-status.ts for the full model.
    const link = domWindow.document.getElementById('hud-indicator-connection') as HTMLElement;
    expect(link.getAttribute('data-element-id')).toBe('0x100000f8');
    ui.setIndicatorActive('connection', true);
    expect(link.style.backgroundImage).toContain('6007498'); // green: state 1
    ui.setIndicatorActive('server-load', true);
    expect(link.style.backgroundImage).toContain('6007498'); // unchanged — no retail input
    ui.setIndicatorActive('server-load', false);
    expect(link.style.backgroundImage).toContain('6007498');
    ui.setIndicatorActive('connection', false);
    expect(link.style.backgroundImage).toContain('600749a'); // red: state 4 (lost)
  });

  it('the effects pair light independently from buffs vs debuffs', () => {
    ui.addEnchantment({ spellId: 1, layer: 1, name: 'Buff', iconId: 0, isBeneficial: true, isVitae: false, isCooldown: false, duration: 60, startTime: 0, casterGuid: 1 });
    const ben = domWindow.document.getElementById('hud-indicator-effects-beneficial') as HTMLElement;
    const harm = domWindow.document.getElementById('hud-indicator-effects-harmful') as HTMLElement;
    expect(ben.style.backgroundImage).toContain('600749c');  // lit
    expect(harm.style.backgroundImage).toContain('600749f'); // still dark
    ui.addEnchantment({ spellId: 2, layer: 1, name: 'Debuff', iconId: 0, isBeneficial: false, isVitae: false, isCooldown: false, duration: 60, startTime: 0, casterGuid: 1 });
    expect(harm.style.backgroundImage).toContain('600749e'); // lit
    ui.clearEnchantments();
    expect(ben.style.backgroundImage).toContain('600749d');
    expect(harm.style.backgroundImage).toContain('600749f');
  });

  it('burden indicator lights at/over carry capacity via setInventoryData', () => {
    const burden = domWindow.document.getElementById('hud-indicator-burden') as HTMLElement;
    expect(burden.getAttribute('data-element-id')).toBe('0x100000f7');
    ui.setInventoryData([], [], 15001, 15000);
    expect(burden.style.backgroundImage).toContain('60074a3'); // lit
    ui.setBurden(100, 15000);
    expect(burden.style.backgroundImage).toContain('60074a2'); // dark
  });

  it('the logout X (0x100000fa) raises the EndCharacterSessionConfirm Yes / No dialog; only Yes fires onLogout; one dialog at a time', () => {
    // gmIndicatorsUI::ListenToElementMessage @ 004bfa90 → EndCharacterSession(1)
    // → gmGamePlayUI::RecvNotice_EndCharacterSession @ 004ebea0 →
    // MakeLogoutConfirmationDialog @ 004eb6a0 (refused while m_logoutContext).
    const x = domWindow.document.getElementById('hud-indicator-logout') as HTMLElement;
    expect(x).toBeTruthy();
    expect(x.getAttribute('data-element-id')).toBe('0x100000fa');
    expect(x.style.backgroundImage).toContain('60074b1');
    // The strip root lets clicks through (pointer-events none, inherited):
    // the X must take them back or a real click never reaches it.
    expect(x.style.pointerEvents).toBe('auto');
    const buttons = (): HTMLElement[] => [...domWindow.document.querySelectorAll('.ac-dialog-button')] as HTMLElement[];
    const click = (el: HTMLElement): void => { el.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true })); };
    // (no DAT dialog template here: the confirmation uses its fallback plate)
    const lr = ui.layoutRenderer;
    ui.layoutRenderer = null;
    const before = logoutFired;
    click(x);
    expect(logoutFired).toBe(before);
    expect(ui.logoutConfirmationOpen).toBe(true);
    expect(buttons().length).toBe(2);
    // A second click while the dialog is up opens nothing new.
    expect(ui.requestEndCharacterSession()).toBe(false);
    click(x);
    expect(buttons().length).toBe(2);
    // No: closes, no logout.
    click(buttons()[1]);
    expect(buttons().length).toBe(0);
    expect(ui.logoutConfirmationOpen).toBe(false);
    expect(logoutFired).toBe(before);
    // Yes: the confirmed logout.
    click(x);
    click(buttons()[0]);
    expect(logoutFired).toBe(before + 1);
    expect(ui.logoutConfirmationOpen).toBe(false);
    ui.layoutRenderer = lr;
  });

  it('legacy wrong-premise ids no-op safely and render no strip button', () => {
    for (const id of ['combat-toggle', 'pk-status', 'peace-war', 'logging', 'fellowship', 'portal-storm']) {
      expect(() => ui.setIndicatorActive(id, true)).not.toThrow();
      expect(domWindow.document.getElementById(`hud-indicator-${id}`)).toBeNull();
    }
  });
});
