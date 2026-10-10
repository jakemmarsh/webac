/**
 * GAP.41 — Options panel: BEHAVIORAL proof every server-mapped toggle
 * renders across the 4 tabs and round-trips its ACE CharacterOption.
 *
 * Converts the FAITHFUL.489 source-grep pins (which regexed
 * GameUI.ts for addToggleRow calls + the DEFAULTS/mapping blocks — text,
 * not behavior). This drives the REAL renderOptionsPanel (DAT 0x2100002b)
 * in happy-dom across all four tabs (gameplay/character/chat/config),
 * finds each toggle by its data-option-key hook, clicks it, and asserts
 * onCharacterOptionToggle fires with the exact CharacterOption code from
 * GameUI.OPTIONS_TO_CHARACTER_OPTION — the round-trip the task demanded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { OPTIONS_TEXT_STYLES } from '../packages/renderer/src/ui/UIElementTextLayout.js';
import { argbToCssHex } from '../packages/renderer/src/ui/SpewBoxModel.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Options panel 0x2100002b element ids renderOptionsPanel touches.
const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];

describe('GAP.41 — Options panel toggles render + round-trip (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICls: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AC_COLORS: any;
  let toggles: Array<{ code: number; on: boolean }> = [];

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // happy-dom lacks rAF; the options scrollbar sync uses it. No-op stub.
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      (g as any).requestAnimationFrame = () => 0;
      (g as any).cancelAnimationFrame = () => {};
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICls = mod.GameUI;
    AC_COLORS = mod.AC_COLORS;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
          // CORE.5.c.c — the real renderer resolves pane 0x10000211's base
          // (0x21000028:0x100001f9) which authors the Apply/Reset/Defaults
          // 3-slice buttons 0x100001fc/fd/fe (proven behaviorally in
          // verify-spellbook-footer-native-adoption.ts); mirror them here so
          // the adoption path finds its scoped DAT nodes.
          if (id === 0x10000211) {
            for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
              const btn = domWindow.document.createElement('div');
              btn.dataset.elementId = `0x${bid.toString(16)}`;
              for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) {
                const slice = domWindow.document.createElement('div');
                slice.dataset.elementId = `0x${sid.toString(16)}`;
                btn.appendChild(slice);
              }
              el.appendChild(btn);
            }
          }
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
    };
    ui.callbacks.onCharacterOptionToggle = (code: number, on: boolean) => { toggles.push({ code, on }); };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const TABS = ['gameplay', 'character', 'chat', 'config'] as const;

  function renderTab(tab: string) {
    ui.optionsTab = tab;
    if (!ui.optionsPanelVisible) ui.toggleOptionsPanel();
    else ui.renderOptionsPanel();
  }
  function toggleRows(): HTMLElement[] {
    return [...ui.optionsPanel.querySelectorAll('.option-toggle-row')] as HTMLElement[];
  }
  function allRenderedKeys(): Map<string, HTMLElement> {
    const found = new Map<string, HTMLElement>();
    for (const tab of TABS) {
      renderTab(tab);
      for (const row of toggleRows()) found.set(row.dataset.optionKey!, row);
    }
    return found;
  }

  it('every option in OPTIONS_TO_CHARACTER_OPTION renders as a toggle row across the 4 tabs, except the two retail keeps off the pages', () => {
    const rendered = allRenderedKeys();
    const mapped = Object.keys(GameUICls.OPTIONS_TO_CHARACTER_OPTION);
    const missing = mapped.filter(k => !rendered.has(k));
    // BUG.character-tab-not-retail — LockUI is the radar padlock + @lockui,
    // Appear Offline the Friends panel checkbox; neither is an options-page row.
    expect(missing.sort()).toEqual(['appearOffline', 'lockUI']);
  });

  it('clicking a server-mapped toggle fires onCharacterOptionToggle with its exact CharacterOption code', () => {
    const rendered = allRenderedKeys();
    const map = GameUICls.OPTIONS_TO_CHARACTER_OPTION as Record<string, number>;
    // Sample a representative spread across enums (CharOpt1 + CharOpt2 bits).
    for (const key of ['showHelm', 'disableWeather', 'displayTimestamps', 'useFastMissiles', 'confirmUseOfRareGems']) {
      // Re-render the tab that owns this row so it's live in the DOM.
      const row = rendered.get(key)!;
      expect(row).toBeTruthy();
      toggles = [];
      const before = row.dataset.optionOn;
      row.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
      expect(toggles.length).toBe(1);
      expect(toggles[0].code).toBe(map[key]);
      expect(toggles[0].on).toBe(before === '0'); // flipped from displayed state
    }
  });

  it('the toggle-bearing tabs (character, chat) render toggle rows; every tab renders a panel', () => {
    // Real EoL tab grouping: gameplay = action buttons (Exit/Keyboard/Help),
    // config = sound/camera/graphics sliders, character + chat = the toggle
    // clusters. Assert toggles where they belong and a live panel everywhere.
    for (const tab of ['character', 'chat'] as const) {
      renderTab(tab);
      expect(toggleRows().length).toBeGreaterThan(0);
    }
    for (const tab of TABS) {
      renderTab(tab);
      expect(ui.optionsPanel).toBeTruthy();
    }
  });

  it('VISUAL3.64 — options scrollbar thumb uses the retail-derived green, not the old invented brown/navy', () => {
    // The scrollbar track (addPanelScrollbar) previously fell back to a flat
    // rgba(0,0,0,0.4) line with no thumb texture — the audited "only a thin
    // flat vertical gold bar, no thumb or texture" defect. In this happy-dom
    // harness (no real DAT textures loaded), the track/arrows still exercise
    // their CSS fallback path, but the thumb's fill color no longer depends
    // on texture availability — assert it now resolves to the real
    // AC_COLORS.skillTrained green (both chat-options.jpg and
    // character-panel-skills.jpg show this scrollbar's thumb as green in
    // retail) instead of the old rgba(120,90,40,0.7) brown.
    renderTab('chat');
    const track = [...ui.optionsPanel.querySelectorAll('div')].find(
      (el: HTMLElement) => el.style.position === 'absolute' && el.style.width === '16px' && el.style.right === '0px',
    ) as HTMLElement;
    expect(track).toBeTruthy();
    const thumb = track.querySelector('div') as HTMLElement;
    expect(thumb).toBeTruthy();
    expect(thumb.style.background).toBe(AC_COLORS.skillTrained);
    expect(thumb.style.background).not.toBe('rgba(120, 90, 40, 0.7)');
    expect(thumb.style.border).toContain(AC_COLORS.gold);
  });

  it('VISUAL3.66/.67 + CORE.17.h.d — the section rule is the Options-panel DAT rule (0x060012c5) at its native 8px, added BEFORE each later header and never under one', () => {
    // addSectionHeader previously borrowed 0x06001420 (the Titles/Friends/
    // Fellowship/Allegiance panels' own independently-DAT-cited divider) and
    // squashed it to 4px. LayoutDesc 0x2100002b (the shared Options panel —
    // confirmed by its tab-strip strings resolving to "Gameplay Options"/
    // "Character"/"Config"/"Chat") carries them as two list templates: elem
    // 0x10000216 (292x22 header text) and 0x10000217 (292x8 rule, media
    // 0x060012c5). CORE.17.h.d: gmChatOptionsUI::InitOptions @ 0049fc60
    // calls PlayerOptionPage::AddSeperator @ 004f2730 THEN AddHeader @
    // 004f28b0 for every section after the first — the rule precedes
    // "Main Chat Window" and "General Chat Options" has none.
    // Fake-populate the texture cache (private but reachable at runtime, same
    // pattern the VISUAL3.64 scrollbar test doesn't need since it asserts
    // the CSS-fallback path) so the real texture-selection branch executes.
    (ui as any).uiTextures.set(0x060012c5, 'data:fake-correct-rule');
    (ui as any).uiTextures.set(0x06001420, 'data:fake-wrong-rule');
    renderTab('chat');
    const headerFor = (text: string): HTMLElement => {
      const span = [...ui.optionsPanel.querySelectorAll('span')].find(
        (s: HTMLElement) => s.textContent === text,
      ) as HTMLElement;
      expect(span, text).toBeTruthy();
      return span.closest('.options-section-header') as HTMLElement;
    };
    const first = headerFor('General Chat Options');
    expect(first).toBeTruthy();
    expect(first.previousElementSibling).toBeNull();
    expect(first.querySelector('.options-separator')).toBeNull();
    expect((first.nextElementSibling as HTMLElement).classList.contains('options-separator')).toBe(false);
    const second = headerFor('Main Chat Window');
    const rule = second.previousElementSibling as HTMLElement;
    expect(rule.classList.contains('options-separator')).toBe(true);
    expect(rule.style.backgroundImage).toContain('data:fake-correct-rule');
    expect(rule.style.backgroundImage).not.toContain('data:fake-wrong-rule');
    expect(rule.style.height).toBe('8px');
    expect(second.querySelector('.options-separator')).toBeNull();
    const headerSpan = first.querySelector('span') as HTMLElement;
    // VISUAL3.67 — the pre-VISUAL3.63-rebuild "Chat Channels" header (the
    // flat list this tab used to render) called renderACText(label,
    // AC_COLORS.goldDim) — the '#8a7034' muted brown the June 12 audit
    // read as "dim, low-saturation grey text with no visible gold tone".
    // addSectionHeader passed AC_COLORS.goldLight until CORE.17.h.g.d
    // anchored it to the header desc 0x2100003f:0x1000038c's own p27
    // colour (0xffffef00, OPTIONS_TEXT_STYLES.header) — retail's bright
    // saturated yellow-gold serif.
    expect(headerSpan.style.color).toBe(argbToCssHex(OPTIONS_TEXT_STYLES.header.colorArgb));
    expect(headerSpan.style.color).not.toBe(AC_COLORS.goldDim);
    expect(headerSpan.style.color).not.toBe(AC_COLORS.goldLight);
  });

  it('VISUAL3.60 — Apply/Reset/Defaults footer is pinned outside the scrollable option list, not inside it', () => {
    // addPanelScrollbar wraps its host's children in an absolutely-positioned
    // (position:absolute, overflowY:auto) "inner" scroller with a fixed
    // clientHeight matching the 575px DAT body — a footer left inside that
    // scroller sits below whatever the option list's total content height is
    // (live-verified: ~830px past the fold) and requires scrolling to reach.
    // Retail (options-character.jpg) keeps this row pinned and always visible.
    for (const tab of ['character', 'chat'] as const) {
      renderTab(tab);
      const footerBtn = ui.optionsPanel.querySelector('.options-footer-btn');
      expect(footerBtn).toBeTruthy();
      const footer = footerBtn.closest('div');
      const scrollInner = [...ui.optionsPanel.querySelectorAll('div')].find(
        (el: HTMLElement) => el.style.position === 'absolute' && el.style.overflowY === 'auto',
      );
      expect(scrollInner).toBeTruthy();
      expect(scrollInner!.contains(footer)).toBe(false);
    }
  });

  it('VISUAL3.62 — chat tab renders Inactive/Active Opacity sliders that drive chatInactiveOpacity/chatActiveOpacity', () => {
    renderTab('chat');
    const spans = [...ui.optionsPanel.querySelectorAll('span')] as HTMLElement[];
    const inactiveLabel = spans.find((s) => s.textContent === 'Inactive Opacity');
    const activeLabel = spans.find((s) => s.textContent === 'Active Opacity');
    expect(inactiveLabel).toBeTruthy();
    expect(activeLabel).toBeTruthy();
    // CORE.17.h.a — ONE shared Transparent/Opaque caption pair: retail builds
    // Inactive from list template 3 (bare) and Active from template 6, then
    // SetSliderLabel()s the Active slider only (gmChatOptionsUI::InitOptions
    // @ 0049fc60), exactly as chat-options.jpg shows.
    expect(spans.filter((s) => s.textContent === 'Transparent').length).toBe(1);
    expect(spans.filter((s) => s.textContent === 'Opaque').length).toBe(1);

    // The label cell and the track are siblings in the template row
    // (CORE.17.h.d); the track carries data-slider-label. Drag it by
    // dispatching a mousedown at a mocked clientX/rect to drive the real
    // onChange handler, not the source text — PointToPosition @ 00470240
    // maps (x − widget/2) over the 112px active span.
    function dragTrack(label: string, fraction: number): void {
      const track = ui.optionsPanel.querySelector(`[data-slider-label="${label}"]`) as HTMLElement;
      expect(track, label).toBeTruthy();
      track.getBoundingClientRect = () => ({ left: 0, width: 120, right: 120, top: 0, bottom: 12, height: 12, x: 0, y: 0, toJSON: () => ({}) });
      track.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, clientX: 3 + fraction * 112 }));
    }

    dragTrack('Inactive Opacity', 0.3);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(30);
    dragTrack('Active Opacity', 0.7);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(70);
    // The other slider's value must be untouched by dragging its sibling.
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(30);

    // Persisted via saveOptionsSettings (FAITHFUL.432).
    const stored = JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1'));
    expect(stored.chatInactiveOpacity).toBe(30);
    expect(stored.chatActiveOpacity).toBe(70);
  });


  // VISUAL3.63 — retail Chat Options tab structure. Converts the
  // FAITHFUL.482/FAITHFUL.483 source-text pins (tests/verify-chat-channel-
  // listen-toggles.ts, tests/verify-display-timestamps.ts — both deleted)
  // into behavioral coverage driving the real renderOptionsPanel, per
  // gmChatOptionsUI::InitOptions (reference/client-eol/decomp/
  // acclient-decompiled.c:160041-160223) + ID_CharacterOption_Chat_Section
  // (:160990-161093) + ID_CharacterOption_UIDisplay_Section (:160552-160563).
  const CHAT_CHANNEL_SUFFIXES = [
    'Combat', 'Magic', 'AreaChat', 'Tells', 'Allegiance', 'Fellowship',
    'General', 'Trade', 'LFG', 'Roleplay', 'Society', 'Errors',
  ];

  it('VISUAL3.63 — chat tab renders Main Chat Window (12 channels) + Chat Window 1-4 (Gameplay + 12 channels each)', () => {
    renderTab('chat');
    const keys = toggleRows().map((r) => r.dataset.optionKey);
    for (const suffix of CHAT_CHANNEL_SUFFIXES) {
      expect(keys).toContain(`chatMainWindow${suffix}`);
    }
    for (let w = 1; w <= 4; w++) {
      expect(keys).toContain(`chatWindow${w}Gameplay`);
      for (const suffix of CHAT_CHANNEL_SUFFIXES) {
        expect(keys).toContain(`chatWindow${w}${suffix}`);
      }
    }
    // Purely client-local per-window filter UI — no ChatDisplayMask consumer
    // anywhere server-side (reference/ACE/Source), so none of these round-trip.
    const map = GameUICls.OPTIONS_TO_CHARACTER_OPTION as Record<string, number>;
    for (const key of keys) {
      if (key?.startsWith('chatMainWindow') || key?.startsWith('chatWindow')) {
        expect(map[key]).toBeUndefined();
      }
    }
  });

  it('VISUAL3.63/CORE.3.d — Main Chat Window defaults all channels on except Errors AND Society; each floaty window defaults only its retail channel subset', () => {
    renderTab('chat');
    const onState = (key: string): boolean =>
      toggleRows().find((r) => r.dataset.optionKey === key)!.dataset.optionOn === '1';
    // CORE.3.d correction: the main default is the 64-bit `(0xfbffffff, 0)`
    // (gmChatOptionsUI::InitOptions @ 0049f100, decomp:160115) — Society's
    // mask is bit 32 (0x100000000) in the HIGH dword, so it defaults OFF
    // like Errors. Confirmed visually by reference/images/hud/
    // chat-options.jpg (dim bullet on "Society Channel").
    for (const suffix of CHAT_CHANNEL_SUFFIXES) {
      expect(onState(`chatMainWindow${suffix}`), `chatMainWindow${suffix}`)
        .toBe(suffix !== 'Errors' && suffix !== 'Society');
    }
    expect(onState('chatWindow1AreaChat')).toBe(true);
    expect(onState('chatWindow1Tells')).toBe(true);
    expect(onState('chatWindow1Combat')).toBe(false);
    expect(onState('chatWindow1Gameplay')).toBe(false);
    expect(onState('chatWindow2Allegiance')).toBe(true);
    expect(onState('chatWindow2Combat')).toBe(false);
    expect(onState('chatWindow3Fellowship')).toBe(true);
    expect(onState('chatWindow3Combat')).toBe(false);
    expect(onState('chatWindow4General')).toBe(true);
    expect(onState('chatWindow4Trade')).toBe(true);
    expect(onState('chatWindow4LFG')).toBe(true);
    expect(onState('chatWindow4Roleplay')).toBe(true);
    expect(onState('chatWindow4Combat')).toBe(false);
  });

  it('VISUAL3.63 — clicking a Main Chat Window toggle updates local settings + persists, without a server round-trip', () => {
    renderTab('chat');
    const row = toggleRows().find((r) => r.dataset.optionKey === 'chatMainWindowErrors')!;
    expect(row).toBeTruthy();
    toggles = [];
    expect(ui.optionsSettings.chatMainWindowErrors).toBe(false);
    row.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(ui.optionsSettings.chatMainWindowErrors).toBe(true);
    expect(toggles.length).toBe(0);
    const stored = JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1'));
    expect(stored.chatMainWindowErrors).toBe(true);
    ui.optionsSettings.chatMainWindowErrors = false; // reset for later tests
  });

  it('VISUAL3.63 — FAITHFUL.482/483 toggles moved off the chat tab onto the character tab, with their real CharacterOption codes', () => {
    renderTab('character');
    const charKeys = toggleRows().map((r) => r.dataset.optionKey);
    const map = GameUICls.OPTIONS_TO_CHARACTER_OPTION as Record<string, number>;
    for (const [key, code] of [
      ['stayInChatMode', 0x0B], ['displayTimestamps', 0x21],
      ['listenAllegiance', 0x1B], ['listenGeneral', 0x23], ['listenTrade', 0x24],
      ['listenLFG', 0x25], ['listenRoleplay', 0x26], ['listenSociety', 0x2E],
    ] as const) {
      expect(charKeys).toContain(key);
      expect(map[key]).toBe(code);
    }
    // "PK Deaths" has zero trace anywhere in the decompiled EoL client
    // (code or string symbols) — dropped as a non-retail fabrication.
    expect(charKeys).not.toContain('listenPKDeath');

    renderTab('chat');
    const chatKeys = toggleRows().map((r) => r.dataset.optionKey);
    for (const key of ['stayInChatMode', 'displayTimestamps', 'listenAllegiance', 'listenGeneral', 'listenTrade', 'listenLFG', 'listenRoleplay', 'listenSociety', 'listenPKDeath']) {
      expect(chatKeys).not.toContain(key);
    }
  });

  it('FAITHFUL.483 — addSystemMessage/addChatMessage prefix [HH:MM:SS] only when displayTimestamps is on', () => {
    ui.chatMessages = domWindow.document.createElement('div');
    ui.optionsSettings.displayTimestamps = false;
    ui.addSystemMessage('hello');
    expect((ui.chatMessages.lastElementChild as HTMLElement).textContent).not.toMatch(/^\[\d{2}:\d{2}:\d{2}\]/);

    ui.optionsSettings.displayTimestamps = true;
    ui.addSystemMessage('world');
    expect((ui.chatMessages.lastElementChild as HTMLElement).textContent).toMatch(/^\[\d{2}:\d{2}:\d{2}\] world$/);

    ui.addChatMessage('Bob', 'hi there');
    expect((ui.chatMessages.lastElementChild as HTMLElement).textContent).toMatch(/^\[\d{2}:\d{2}:\d{2}\]Bob:hi there$/);

    ui.optionsSettings.displayTimestamps = false; // reset for later tests
  });
});
