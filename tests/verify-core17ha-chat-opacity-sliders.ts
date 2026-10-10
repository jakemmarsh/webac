/**
 * CORE.17.h.a — the Chat Options Inactive/Active Opacity sliders behave as
 * the retail UIOption_Sliders bound to gameplay options 0x10000080/81.
 *
 * Decompiled EoL client (reference/client-eol):
 *  - gmChatOptionsUI::InitOptions @ 0049fc60 binds the two sliders via
 *    UIOption_Slider::SetGameplayOptionProperty @ 00485030, which seeds
 *    m_default from UIOption::InqDefaultGameplayOptionProperty @ 004ef8d0 —
 *    the DBPropertyCollection at DBCache::GetDIDFromEnumStatic(0x16). The
 *    DAT resolves that through the master DidMapper 0x25000000 → UNIQUEDB
 *    0x25000002 → 0x16 = 0x78000001 "GameplayOptionDefaults" (0x15 =
 *    0x78000000 "GameplayOptionList"): 0x10000080 = 0.5, 0x10000081 = 1.0.
 *  - UIOption_Slider::GetValue @ 00485420: PlayerModule::InqOption miss →
 *    the slider shows m_default. A fresh character (no GameplayOptions blob,
 *    PlayerModule::PlayerModule @ 005d51f0 starts an EMPTY collection — no
 *    DAT seeding exists) therefore shows Inactive at 50%, Active at 100%.
 *  - vtable slot 0x2d4 = Apply: a drag (ListenToElementMessage @ 00484b50)
 *    and SetCurrentValue @ 00484bd0 both run Apply → PlayerModule::SetOption
 *    @ 005d52c0, so the option EXISTS from the first drag; RestoreSavedValue
 *    @ 00484ae0 (Reset, changed options only — OptionPage::RestoreSavedValues
 *    @ 004f2d00) and RestoreDefaultValue @ 00484b10 (Defaults — OptionPage::
 *    RestoreDefaultValues @ 004f2cb0) go through the same Apply.
 *  - gmChatOptionsUI::OnOptionChanged @ 0049f5d0 links the pair
 *    (m_hashSliderLinks): Inactive above Active pushes Active up, Active
 *    below Inactive pulls Inactive down, via the partner's SetCurrentValue.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const HAS_DAT = existsSync(PORTAL_DAT);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Element ids the options pane mock must expose (footer buttons under the
// Chat pane 0x10000211, as verify-options-panel-behavioral.ts does).
const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];
const FOOTER_BTN_IDS = [0x100001fc, 0x100001fd, 0x100001fe];

describe('CORE.17.h.a — Chat Options opacity sliders (real GameUI under happy-dom)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICls: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const savedBlobs: any[] = [];

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      (g as any).requestAnimationFrame = () => 0;
      (g as any).cancelAnimationFrame = () => {};
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICls = mod.GameUI;
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
          if (id === 0x10000211) {
            for (const bid of FOOTER_BTN_IDS) {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ui.callbacks.onSaveChatWindowOptions = (data: any) => { savedBlobs.push(data); };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function openChatTab(): void {
    ui.optionsTab = 'chat';
    if (!ui.optionsPanelVisible) ui.toggleOptionsPanel();
    else ui.renderOptionsPanel();
  }
  function closePanel(): void {
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
  }
  function sliderTrack(label: string): HTMLElement {
    // The same hook capture-ui-screens.ts drags in the live client.
    const track = ui.optionsPanel.querySelector(`[data-slider-label="${label}"]`) as HTMLElement | null;
    expect(track, `slider track "${label}"`).toBeTruthy();
    return track!;
  }
  // CORE.17.h.d — the track is the retail UIOption_Slider (120x12, 7x12
  // widget, no fill bar): the displayed position is the widget's x over the
  // active span (track − widget = 113px, PositionToWidgetX0Y0 @ 004709a0),
  // published as data-slider-pos in percent.
  const TRACK_W = 120;
  const THUMB_W = 7;
  const ACTIVE = TRACK_W - THUMB_W;
  /** The displayed position in percent, cross-checked against the widget's pixel x. */
  function sliderPos(track: HTMLElement): number {
    const pos = Number(track.dataset.sliderPos);
    const thumb = track.querySelector('.options-slider-thumb') as HTMLElement;
    expect(parseInt(thumb.style.left, 10)).toBe(Math.floor((pos / 100) * ACTIVE));
    return pos;
  }
  /** Mousedown at the x PointToPosition @ 00470240 maps to `fraction`: widget/2 + fraction × (active − 1). */
  function drag(track: HTMLElement, fraction: number): void {
    track.getBoundingClientRect = () => ({ left: 0, width: TRACK_W, right: TRACK_W, top: 0, bottom: 12, height: 12, x: 0, y: 0, toJSON: () => ({}) });
    track.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, clientX: Math.floor(THUMB_W / 2) + fraction * (ACTIVE - 1) }));
  }
  function footer(id: number): HTMLElement {
    const btn = ui.optionsPanel.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
    expect(btn, `footer button 0x${id.toString(16)}`).toBeTruthy();
    return btn;
  }
  function resetToFresh(): void {
    closePanel();
    ui.flushChatOptionsSave(); // drain a pending SaveToServer from the previous case
    savedBlobs.length = 0;
    ui.optionsSettings.chatInactiveOpacity = 50;
    ui.optionsSettings.chatActiveOpacity = 100;
    ui.optionsSettings.chatInactiveOpacitySet = false;
    ui.optionsSettings.chatActiveOpacitySet = false;
    ui.setServerChatWindowOptions(null);
  }

  it('fresh character (no PlayerModule option): Inactive shows the DAT default 50%, Active 100%, and neither option exists', () => {
    resetToFresh();
    openChatTab();
    expect(sliderPos(sliderTrack('Inactive Opacity'))).toBe(50);
    expect(sliderPos(sliderTrack('Active Opacity'))).toBe(100);
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(false);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(false);
    const blob = ui.buildChatWindowOptionsData();
    expect(blob.defaultOpacity).toBeUndefined();
    expect(blob.activeOpacity).toBeUndefined();
    // The main window still sits on gmMainChatUI's constructor 1.0/1.0.
    expect(ui.mainChatOpacityState()).toEqual({ defaultOpacity: 1.0, activeOpacity: 1.0 });
  });

  it('one Transparent/Opaque caption pair, under the Active slider only (template 3 vs 6 + SetSliderLabel(Active) in InitOptions @ 0049fc60)', () => {
    resetToFresh();
    openChatTab();
    const inactiveRow = sliderTrack('Inactive Opacity').parentElement!;
    const activeRow = sliderTrack('Active Opacity').parentElement!;
    const captions = (row: HTMLElement): string[] =>
      [...row.querySelectorAll('span')].map((s) => s.textContent).filter((t) => t === 'Transparent' || t === 'Opaque') as string[];
    expect(captions(inactiveRow)).toEqual([]);
    expect(captions(activeRow)).toEqual(['Transparent', 'Opaque']);
  });

  it('a server blob with only 0x10000080 = 0.25 moves the Inactive thumb to 25% and leaves Active on its default', () => {
    resetToFresh();
    ui.setServerChatWindowOptions({ defaultOpacity: 0.25, chatWindows: new Map() });
    openChatTab();
    expect(sliderPos(sliderTrack('Inactive Opacity'))).toBe(25);
    expect(sliderPos(sliderTrack('Active Opacity'))).toBe(100);
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(false);
  });

  it('dragging Inactive above Active pushes the Active thumb up to it (gmChatOptionsUI::OnOptionChanged link) and both options exist', () => {
    resetToFresh();
    ui.setServerChatWindowOptions({ defaultOpacity: 0.5, activeOpacity: 0.6, chatWindows: new Map() });
    openChatTab();
    const inactive = sliderTrack('Inactive Opacity');
    const active = sliderTrack('Active Opacity');
    expect(sliderPos(active)).toBe(60);
    drag(inactive, 0.8);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(80);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(80);
    expect(sliderPos(active)).toBe(80);
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(true);
    // Below Active: the partner is untouched.
    drag(inactive, 0.3);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(30);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(80);
    expect(sliderPos(active)).toBe(80);
  });

  it('dragging Active below Inactive pulls the Inactive thumb down with it', () => {
    resetToFresh();
    openChatTab();
    const inactive = sliderTrack('Inactive Opacity');
    const active = sliderTrack('Active Opacity');
    drag(active, 0.3);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(30);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(30);
    expect(sliderPos(inactive)).toBe(30);
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(true);
    // The windows follow: default <= active holds at 0.3/0.3.
    expect(ui.mainChatOpacityState()).toEqual({ defaultOpacity: 0.3, activeOpacity: 0.3 });
    expect(ui.floatyChatOpacityState()).toEqual({ defaultOpacity: 0.3, activeOpacity: 0.3 });
  });

  it('Defaults on the Chat tab writes the DAT defaults 0.5/1.0 into the PlayerModule (RestoreDefaultValue → Apply) and the blob carries both', () => {
    resetToFresh();
    openChatTab();
    drag(sliderTrack('Active Opacity'), 0.3);
    savedBlobs.length = 0;
    footer(0x100001fe).dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(50);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(100);
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(true);
    // Re-rendered sliders sit at the defaults.
    expect(sliderPos(sliderTrack('Inactive Opacity'))).toBe(50);
    expect(sliderPos(sliderTrack('Active Opacity'))).toBe(100);
    // The main window now follows the options (0.5 while inactive), no
    // longer the constructor 1.0.
    expect(ui.mainChatOpacityState()).toEqual({ defaultOpacity: 0.5, activeOpacity: 1.0 });
    ui.flushChatOptionsSave();
    expect(savedBlobs.length).toBe(1);
    expect(savedBlobs[0].defaultOpacity).toBeCloseTo(0.5, 6);
    expect(savedBlobs[0].activeOpacity).toBeCloseTo(1.0, 6);
  });

  it('Defaults on another tab leaves the Chat page\'s options alone (OptionPage::RestoreDefaultValues is per page)', () => {
    resetToFresh();
    ui.optionsTab = 'config';
    if (!ui.optionsPanelVisible) ui.toggleOptionsPanel(); else ui.renderOptionsPanel();
    footer(0x100001fe).dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(false);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(false);
    expect(ui.mainChatOpacityState()).toEqual({ defaultOpacity: 1.0, activeOpacity: 1.0 });
  });

  it('Reset after a drag restores the panel-open value AND the changed option exists (RestoreSavedValue → Apply); an untouched slider stays absent', () => {
    resetToFresh();
    openChatTab(); // snapshot: 50/100, both absent
    drag(sliderTrack('Inactive Opacity'), 0.2);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(20);
    footer(0x100001fd).dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(50);
    expect(ui.optionsSettings.chatActiveOpacity).toBe(100);
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(true);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(false);
    expect(sliderPos(sliderTrack('Inactive Opacity'))).toBe(50);
    const blob = ui.buildChatWindowOptionsData();
    expect(blob.defaultOpacity).toBeCloseTo(0.5, 6);
    expect(blob.activeOpacity).toBeUndefined();
  });

  it('Reset with nothing changed writes nothing (OptionPage::RestoreSavedValues only restores Changed options)', () => {
    resetToFresh();
    openChatTab();
    savedBlobs.length = 0;
    footer(0x100001fd).dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.chatInactiveOpacitySet).toBe(false);
    expect(ui.optionsSettings.chatActiveOpacitySet).toBe(false);
    ui.flushChatOptionsSave();
    expect(savedBlobs.length).toBe(0);
    closePanel();
  });

  it('GameUI.OPTIONS_DEFAULTS still mirrors 0x78000001 (50 / 100) after the drags above — a first session must not alias the static dict as its live settings', () => {
    expect(GameUICls.OPTIONS_DEFAULTS.chatInactiveOpacity).toBe(50);
    expect(GameUICls.OPTIONS_DEFAULTS.chatActiveOpacity).toBe(100);
  });
});

/* ── DAT ground truth (skipped in CI — no dat/) ───────────────────────── */

describe.skipIf(!HAS_DAT)('CORE.17.h.a — DAT: DBCache::GetDIDFromEnumStatic(0x15/0x16) resolves to the GameplayOption list/defaults', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let master: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let uniqueDb: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let defaults: Map<number, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let list: Map<number, any>;

  beforeAll(async () => {
    const { DatDatabase, DatReader, parseMasterProperty, setMasterPropertyTypes, DbProperty } =
      await import('../packages/dat-parser/src/index.js');
    const { readDidMapper } = await import('../packages/dat-parser/src/file-types/DidMapper.js');
    const buf = readFileSync(PORTAL_DAT);
    const db = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    // DBCache::GetDIDFromEnum @ 00413940: master map (portal header
    // MasterMapID, header offset 0x140 + 0x30) → category sub-map → enum → DID.
    const masterMapId = new DataView(buf.buffer, buf.byteOffset + 0x140, 0x60).getUint32(0x30, true);
    expect(masterMapId).toBe(0x25000000);
    master = readDidMapper(new DatReader(db.getFileData(masterMapId)!));
    const uniqueDbId = master.client.enumToId.get(0x2);
    uniqueDb = readDidMapper(new DatReader(db.getFileData(uniqueDbId)!));
    setMasterPropertyTypes(parseMasterProperty(new DatReader(db.getFileData(0x39000001)!)));
    defaults = DbProperty.read(new DatReader(db.getFileData(uniqueDb.client.enumToId.get(0x16))!)).properties;
    list = DbProperty.read(new DatReader(db.getFileData(uniqueDb.client.enumToId.get(0x15))!)).properties;
  });

  it('master 0x25000000 category 2 is UNIQUEDB → 0x25000002', () => {
    expect(master.client.enumToName.get(0x2)).toBe('UNIQUEDB');
    expect(master.client.enumToId.get(0x2)).toBe(0x25000002);
  });

  it('UNIQUEDB enum 0x16 = 0x78000001 "GameplayOptionDefaults", 0x15 = 0x78000000 "GameplayOptionList"', () => {
    expect(uniqueDb.client.enumToId.get(0x16)).toBe(0x78000001);
    expect(uniqueDb.client.enumToName.get(0x16)).toBe('GameplayOptionDefaults');
    expect(uniqueDb.client.enumToId.get(0x15)).toBe(0x78000000);
    expect(uniqueDb.client.enumToName.get(0x15)).toBe('GameplayOptionList');
  });

  it('the defaults collection seeds the sliders: 0x10000080 = 0.5, 0x10000081 = 1.0 (float properties)', () => {
    expect(defaults.get(0x10000080)?.valueFloat).toBeCloseTo(0.5, 6);
    expect(defaults.get(0x10000081)?.valueFloat).toBeCloseTo(1.0, 6);
  });

  it('the option list is the 0xd2 array UIOption::InqGameplayOptionProperty @ 004ef4d0 walks for names/tooltips', () => {
    expect(list.has(0xd2)).toBe(true);
    expect(Array.isArray(list.get(0xd2)?.valueArray)).toBe(true);
    expect(list.get(0xd2).valueArray.length).toBeGreaterThan(0);
  });
});
