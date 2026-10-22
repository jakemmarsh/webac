/**
 * docs/ac1999-support-scope.md Phase 5, "No dead-end UI": while the world is
 * a 1999 one, the interface hides the controls of features the November 1999
 * client never had (secure trade, housing, consent, chess, TurbineChat,
 * contracts, character titles, salvage, fellowship leadership). The World
 * panel is client-side and stays (Jake 2026-10-06); the toolbar's tab row
 * closes up around the hidden journal button instead of leaving a hole. End
 * of retail and the classic eras keep every control.
 *
 * Evidence: the AC1999 KB's builder scans (knowledge/kb/game-mechanics/
 * *-absent.md, the 0xF7B1 inner-opcode catalog), cross-checked here against
 * the real 1999 client's captured session: it never sends any of them.
 *
 * Behavioral: the real adapter, the real Keyboard Config model and the real
 * GameUI in happy-dom, era 'ac1999-retail' vs 'eor'.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { ABSENT_1999, absent1999FeatureOfAction } from '../packages/network/src/era1999/Absent1999.js';
import { serializeGameAction } from '../packages/network/src/MessageSerializer.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { decodeCapture } from '../tools/ac1999/decode-capture.js';
import { ERA_PROFILES, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import {
  unsupportedFeatures, hiddenBy, FEATURE_KEYBIND_ACTIONS, FEATURE_CHARACTER_OPTIONS, FEATURE_TOOLBAR_BUTTONS, FEATURE_PANELS, eraClientRules, type EraFeature,
  FEATURE_COMMANDS, FEATURE_SOCIAL_TABS, FEATURE_WORLD_TABS, FEATURE_INDICATORS, FEATURE_COMPONENT_CONTROLS, FEATURE_FELLOWSHIP_CONTROLS,
} from '../packages/renderer/src/era/EraFeatures.js';
import { CommandSystem } from '../packages/renderer/src/chat/commands/CommandSystem.js';
import { retailCommandEntries, type RetailCommandContext } from '../packages/renderer/src/chat/commands/index.js';
import { withoutWithheldLines } from '../packages/renderer/src/chat/commands/TextUiHelpCommands.js';
import { SkillTable } from '../packages/dat-parser/src/file-types/SkillTable.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { LocalChatGate } from '../packages/renderer/src/chat/LocalChatGate.js';
import { EquipMask } from '../packages/shared/src/game-types.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ActionClass } from '../packages/renderer/src/input/KeybindActionClass.js';
import { DEFAULT_KEYBINDS } from '../packages/renderer/src/input/KeybindDefaults.js';
import { buildKeyboardSections, keyboardHiddenActions } from '../packages/renderer/src/ui/KeyboardConfigModel.js';
import { CHARACTER_SETTINGS_ROWS } from '../packages/renderer/src/ui/CharacterSettingsModel.js';
import { TalkFocus } from '../packages/renderer/src/ui/ChatTalkFocus.js';
import { collapseToolbarTabs } from '../packages/renderer/src/ui/ToolbarTabs.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const ERA_1999 = unsupportedFeatures(eraProfile('ac1999-retail'));
const ERA_EOR = unsupportedFeatures(eraProfile('eor'));
const ERA_CLASSIC = unsupportedFeatures(eraProfile('classic-dereth'));

describe('era capability set', () => {
  it('a 1999 world lacks every absent feature plus the end-of-retail wcid tables, and nothing client-side', () => {
    for (const f of Object.keys(ABSENT_1999)) expect(ERA_1999.has(f as EraFeature), f).toBe(true);
    expect(ERA_1999.has('eolWcidTables')).toBe(true);
    // Every entry is an absent feature or one of those justified in EraFeatures.ts.
    const extra = [...ERA_1999].filter((f) => !(f in ABSENT_1999)).sort();
    expect(extra).toEqual(['autoAcceptFellowship', 'cloaks', 'desiredComponents', 'eolWcidTables', 'fishing', 'friendsPanel', 'netherDamage', 'rareGems', 'squelchListPage']);
    // BUG.ac1999-eor-ui-values: the paperdoll's slots are the era's data (no cloak or trinket slot on 1999).
    const slots1999 = eraClientRules(eraProfile('ac1999-retail')).equipSlotMask;
    expect(slots1999 & (EquipMask.TrinketOne | EquipMask.Cloak)).toBe(0);
    expect(eraClientRules(eraProfile('eor')).equipSlotMask & (EquipMask.TrinketOne | EquipMask.Cloak)).not.toBe(0);
    // The World panel is client-side: its button, panel and keys stay on 1999.
    expect(hiddenBy(FEATURE_TOOLBAR_BUTTONS, ERA_1999).has('tb-map')).toBe(false);
    expect(hiddenBy(FEATURE_PANELS, ERA_1999).has('map')).toBe(false);
    expect([...hiddenBy(FEATURE_TOOLBAR_BUTTONS, ERA_1999)]).toEqual(['tb-journal']);
  });

  it('end of retail and every classic era lack nothing', () => {
    for (const p of Object.values(ERA_PROFILES)) {
      if (p.id === 'ac1999-retail') continue;
      expect([...unsupportedFeatures(p)], p.id).toEqual([]);
    }
    expect(ERA_EOR.size).toBe(0);
  });

  it('every option row the 1999 world hides is a real retail Character-page row', () => {
    const names = new Set(CHARACTER_SETTINGS_ROWS.map((r) => r.playerOption));
    for (const n of hiddenBy(FEATURE_CHARACTER_OPTIONS, ERA_1999)) expect(names.has(n), n).toBe(true);
  });
});

describe('the 1999 adapter drops the absent features, naming them', () => {
  const messages = decodeCapture(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')));

  it('the real 1999 client never sent an absent feature\'s action', () => {
    const sent = messages.filter((m) => m.dir === 'c2s' && m.opcode === 0xf7b1).map((m) => m.inner as number);
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.filter((a) => absent1999FeatureOfAction(a) !== null)).toEqual([]);
  });

  it('no absent action has a codec; an OpenTradeNegotiations is dropped with a secure-trade note', () => {
    const c = codecs1999();
    for (const e of Object.values(ABSENT_1999)) for (const a of e.actions) expect(c.outboundAction.has(a), a.toString(16)).toBe(false);
    const notes: string[] = [];
    const adapter = new Adapter1999(c, { account: 'acjs', log: (m) => notes.push(m) });
    const body = new Uint8Array(4);
    expect(adapter.outbound(serializeGameAction(1, GameActionType.OpenTradeNegotiations, body))).toBeNull();
    expect(notes).toEqual(['[1999] 0xf7b1/0x1f6 has no 1999 counterpart (secure trade (September 2000): not in the 1999 game); not sent']);
  });
});

describe('collapseToolbarTabs (ui/ToolbarTabs.ts): a hidden tab leaves no hole', () => {
  // LayoutDesc 0x21000016's tab row.
  const SLOTS = [
    { id: 'tb-social', x: 55, w: 35 }, { id: 'tb-magic', x: 85, w: 34 }, { id: 'tb-char', x: 115, w: 34 },
    { id: 'tb-journal', x: 145, w: 34 }, { id: 'tb-map', x: 175, w: 34 }, { id: 'tb-opt', x: 204, w: 34 },
  ];

  it('nothing hidden: the layout x, no filler', () => {
    const r = collapseToolbarTabs(SLOTS, new Set());
    expect(r.tabs).toEqual(SLOTS);
    expect(r.filler).toBeNull();
  });

  it('the journal hidden: map and options close up by its step, the freed end is filler', () => {
    const r = collapseToolbarTabs(SLOTS, new Set(['tb-journal']));
    expect(r.tabs.map((t) => [t.id, t.x])).toEqual([['tb-social', 55], ['tb-magic', 85], ['tb-char', 115], ['tb-map', 145], ['tb-opt', 174]]);
    expect(r.filler).toEqual({ x: 208, w: 30 });
  });

  it('two hidden: both steps; the last tab hidden: only the filler', () => {
    const two = collapseToolbarTabs(SLOTS, new Set(['tb-journal', 'tb-map']));
    expect(two.tabs.map((t) => t.x)).toEqual([55, 85, 115, 145]);
    expect(two.filler).toEqual({ x: 179, w: 59 });
    const last = collapseToolbarTabs(SLOTS, new Set(['tb-opt']));
    expect(last.tabs.map((t) => t.x)).toEqual([55, 85, 115, 145, 175]);
    expect(last.filler).toEqual({ x: 209, w: 29 });
  });
});

describe('Keyboard Config: a 1999 world lists no command for a missing feature', () => {
  const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
  const ids = (cls: ActionClass, hidden?: ReadonlySet<number>) =>
    new Set(buildKeyboardSections(reg, cls, undefined, hidden).flatMap((s) => s.rows.map((r) => r.id)));
  const hidden1999 = keyboardHiddenActions(hiddenBy(FEATURE_KEYBIND_ACTIONS, ERA_1999));

  it('1999: no House / Titles / Contracts / Quest commands, no TurbineChat or trade option keys; World / Map stay', () => {
    const ui = ids(ActionClass.UI, hidden1999);
    for (const id of [0x10000018, 0x1000011a, 0x1000012e, 0x10000127, 0x10000128]) expect(ui.has(id), id.toString(16)).toBe(false);
    for (const id of [0x10000016, 0x10000017]) expect(ui.has(id), id.toString(16)).toBe(true);
    const cs = ids(ActionClass.CharacterSettings, hidden1999);
    for (const id of [0x10000074, 0x10000088, 0x10000081, 0x1000010e, 0x10000125]) expect(cs.has(id), id.toString(16)).toBe(false);
    // BUG.ac1999-eor-ui sweep: the cloak / rare gem / fishing options and the journal page list go with their features.
    expect(ui.has(0x10000129)).toBe(false);
    for (const id of [0x1000012f, 0x10000123, 0x10000090]) expect(cs.has(id), id.toString(16)).toBe(false);
    // 1999's own commands stay (Show/Hide Inventory, Run as Default Movement), and the retail dead ends stay hidden.
    expect(ui.has(0x10000019)).toBe(true);
    expect(cs.has(0x1000007b)).toBe(true);
    expect(ui.has(0x10000003)).toBe(false);
  });

  it('end of retail: every one of them is listed', () => {
    const ui = ids(ActionClass.UI);
    for (const id of [0x10000016, 0x10000017, 0x1000011a, 0x1000012e]) expect(ui.has(id), id.toString(16)).toBe(true);
    expect(ids(ActionClass.CharacterSettings).has(0x10000074)).toBe(true);
    expect(ui.has(0x10000129)).toBe(true);
    for (const id of [0x1000012f, 0x10000123, 0x10000090]) expect(ids(ActionClass.CharacterSettings).has(id), id.toString(16)).toBe(true);
  });
});

// ── The real GameUI ──────────────────────────────────────────────────────────

/** A LayoutRenderer stand-in whose handles create any element asked for (click-through divs). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(H: GameUIFixture): any {
  const doc = H.win.document;
  const makeHandle = (parent: HTMLElement) => {
    const root = doc.createElement('div');
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) {
        el = doc.createElement('div') as HTMLElement;
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs: new Map(),
      setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop, resizeSubtree: noop,
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  return {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    getTextureDataURLWithAlpha: () => null,
    getResolvedLayout: () => null,
    setFontResolver: () => {},
  };
}

for (const [era, features] of [['ac1999-retail', ERA_1999], ['eor', ERA_EOR]] as const) {
  const is1999 = era === 'ac1999-retail';
  describe(`GameUI controls, era ${era} (behavioral)`, () => {
    let H: GameUIFixture;
    beforeAll(async () => {
      H = await mountGameUI();
      H.ui.layoutRenderer = stubLayoutRenderer(H);
      H.ui.setUnsupportedFeatures(features);
    }, 60_000);
    afterAll(() => H?.teardown());

    it(is1999 ? 'the toolbar has a map button and no journal, and its tab row has no hole' : 'the toolbar keeps the journal and map buttons at the layout x', () => {
      H.ui.uiManager.setScreen('game');
      H.ui.renderHUD();
      const doc = H.win.document;
      for (const id of ['tb-social', 'tb-magic', 'tb-char', 'tb-map', 'tb-opt', 'tb-inv']) expect(doc.getElementById(id), id).toBeTruthy();
      expect(!!doc.getElementById('tb-journal')).toBe(!is1999);
      const left = (id: string): number => parseFloat((doc.getElementById(id) as HTMLElement).style.left);
      const filler = doc.querySelector('.tb-tab-filler') as HTMLElement | null;
      if (is1999) {
        // The map and options tabs close up into the journal's slot (layout 0x21000016 x 145 / 175 / 204).
        expect([left('tb-social'), left('tb-magic'), left('tb-char'), left('tb-map'), left('tb-opt')]).toEqual([55, 85, 115, 145, 174]);
        // The freed end of the row (to the options slot's right edge, 238) is the plain bar, under the separator.
        expect(filler).toBeTruthy();
        expect([parseFloat(filler!.style.left), parseFloat(filler!.style.width)]).toEqual([208, 30]);
        expect(filler!.style.pointerEvents).toBe('none');
      } else {
        expect([left('tb-social'), left('tb-magic'), left('tb-char'), left('tb-journal'), left('tb-map'), left('tb-opt')]).toEqual([55, 85, 115, 145, 175, 204]);
        expect(filler).toBeNull();
      }
    });

    it(is1999 ? 'the indicator strip has no mini-game icon' : 'the indicator strip keeps the mini-game icon', () => {
      // The toolbar test above rendered the HUD (the indicator strip with it).
      const icon = H.win.document.getElementById("hud-indicator-minigame") as HTMLElement | null;
      expect(icon).toBeTruthy();
      expect(icon!.style.display === 'none').toBe(is1999);
      for (const id of ['connection', 'vitae', 'burden', 'effects-beneficial']) {
        expect((H.win.document.getElementById(`hud-indicator-${id}`) as HTMLElement).style.display, id).not.toBe('none');
      }
      expect(hiddenBy(FEATURE_INDICATORS, features).has('minigame')).toBe(is1999);
    });

    it('the map button opens the World panel', () => {
      const btn = H.win.document.getElementById('tb-map') as HTMLElement;
      btn.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
      expect(H.ui.mapPanelVisible).toBe(true);
      btn.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
      expect(H.ui.mapPanelVisible).toBe(false);
    });

    it(is1999 ? 'the contracts panel never opens (keys, restored state); the map does' : 'the map and contracts panels open', () => {
      H.ui.toggleContractPanel();
      expect(H.ui.contractVisible).toBe(!is1999);
      if (H.ui.contractVisible) H.ui.toggleContractPanel();
      H.ui.toggleMapPanel();
      expect(H.ui.mapPanelVisible).toBe(true);
      H.ui.toggleMapPanel();
      expect(H.ui.mapPanelVisible).toBe(false);
    });

    it(is1999 ? 'the Chat menu lists no TurbineChat room' : 'the Chat menu lists all 14 rows', () => {
      const button = H.win.document.createElement('div');
      H.container.appendChild(button);
      H.ui.chatHandle = { elements: new Map([[0x10000014, button]]), setText: () => {} };
      H.ui.toggleTalkFocusMenu();
      const rows = [...H.win.document.querySelectorAll('[data-talk-focus-item]')].map((r) => (r as HTMLElement).dataset.talkFocusItem);
      H.ui.closeTalkFocusMenu();
      const rooms = [TalkFocus.Allegiance, TalkFocus.General, TalkFocus.Trade, TalkFocus.Lfg, TalkFocus.Roleplay, TalkFocus.Society, TalkFocus.Olthoi].map(String);
      expect(rows.length).toBe(is1999 ? 7 : 14);
      for (const r of rooms) expect(rows.includes(r), r).toBe(!is1999);
      for (const r of ['squelch', String(TalkFocus.Say), String(TalkFocus.Fellows), String(TalkFocus.Patron)]) expect(rows.includes(r), r).toBe(true);
    });

    const optionKeys = (tab: string): Set<string> => {
      H.ui.optionsTab = tab;
      if (!H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel();
      else H.ui.renderOptionsPanel();
      return new Set([...H.ui.optionsPanel.querySelectorAll('.option-toggle-row')].map((r: HTMLElement) => r.dataset.optionKey as string));
    };

    it(is1999 ? 'the Character page drops trade / housing / consent / chess / titles / salvage / TurbineChat rows' : 'the Character page keeps every row', () => {
      const keys = optionKeys('character');
      const gone = ['ignoreTradeRequests', 'dragItemToPlayerOpensTrade', 'disableHouseRestrictionEffects', 'acceptCorpseLooting',
        'allowSeeChessRank', 'allowSeeNumberOfTitles', 'salvageMultipleMaterialsAtOnce', 'useCraftingChanceOfSuccessDialog',
        'listenAllegiance', 'listenGeneral', 'listenTrade', 'listenLFG', 'listenRoleplay', 'listenSociety',
        'showCloak', 'confirmUseOfRareGems', 'allowSeeFishingSkill'];
      for (const k of gone) expect(keys.has(k), k).toBe(!is1999);
      for (const k of ['runAsDefault', 'allowGive', 'ignoreFellowshipRequests', 'displayTimestamps']) expect(keys.has(k), k).toBe(true);
    });

    it(is1999 ? 'the Chat page has no TurbineChat room filters' : 'the Chat page keeps the room filters', () => {
      const keys = optionKeys('chat');
      for (const s of ['General', 'Trade', 'LFG', 'Roleplay', 'Society']) {
        expect(keys.has(`chatMainWindow${s}`), s).toBe(!is1999);
        expect(keys.has(`chatWindow4${s}`), s).toBe(!is1999);
      }
      for (const s of ['Combat', 'Tells', 'Allegiance', 'Fellowship']) expect(keys.has(`chatMainWindow${s}`), s).toBe(true);
    });

    it(is1999 ? 'the character panel has no Titles tab and its key does nothing' : 'the Titles tab opens', () => {
      H.ui.toggleCharPage('titles');
      expect(H.ui.charPanelTab === 'titles').toBe(!is1999);
      expect(H.ui.eraSupports('characterTitles')).toBe(!is1999);
    });

    it(is1999 ? 'the Friends page never opens (key, restored tab)' : 'the Friends page opens', () => {
      H.ui.socialTab = 'fellowship';
      H.ui.toggleSocialPage('friends');
      expect(H.ui.socialTab === 'friends').toBe(!is1999);
      if (H.ui.socialPanelVisible) H.ui.toggleSocialPanel();
      H.ui.socialTab = 'friends';
      H.ui.setUnsupportedFeatures(features);
      expect(H.ui.socialTab === 'friends').toBe(!is1999);
      expect(hiddenBy(FEATURE_KEYBIND_ACTIONS, features).has(0x10000118)).toBe(is1999);
    });

    it(is1999 ? 'the Squelch page never opens (1999 lists no squelched names)' : 'the Squelch page opens', () => {
      H.ui.socialTab = 'fellowship';
      H.ui.toggleSocialPage('squelch');
      expect(H.ui.socialTab === 'squelch').toBe(!is1999);
      if (H.ui.socialPanelVisible) H.ui.toggleSocialPanel();
      expect(hiddenBy(FEATURE_SOCIAL_TABS, features).has('squelch')).toBe(is1999);
    });

    it(is1999 ? 'the World panel has no House page (tab, key, restored state)' : 'the World panel opens its House page', () => {
      H.ui.toggleMapPanel();
      expect(H.ui.mapPanelVisible).toBe(true);
      H.ui.openWorldPanelTab('house');
      expect(H.ui.getWorldPanelTab()).toBe(is1999 ? 'map' : 'house');
      H.ui.openWorldPanelTab('map');
      H.ui.toggleMapPanel();
      expect(H.ui.mapPanelVisible).toBe(false);
      expect(hiddenBy(FEATURE_WORLD_TABS, features).has('house')).toBe(is1999);
    });
  });
}

/** Layout 0x21000071: the strip root 0x10000610's direct children (x, y, w, h). */
const STRIP_RECTS: ReadonlyMap<number, readonly [number, number, number, number]> = new Map([
  [0x1000064f, [0, 25, 5, 5]], [0x10000650, [5, 25, 140, 5]], [0x10000651, [145, 25, 5, 5]], [0x10000652, [145, 5, 5, 20]],
  [0x100000f3, [105, 5, 20, 20]], [0x100000f4, [65, 5, 20, 20]], [0x100000f5, [25, 5, 20, 20]], [0x100000f6, [45, 5, 20, 20]],
  [0x10000643, [0, 0, 5, 5]], [0x100000f7, [85, 5, 20, 20]], [0x10000644, [5, 0, 140, 5]], [0x100000f8, [5, 5, 20, 20]],
  [0x10000645, [145, 0, 5, 5]], [0x10000646, [0, 5, 5, 20]], [0x100000fa, [125, 5, 20, 20]], [0x10000647, [0, 25, 5, 5]],
  [0x10000648, [5, 25, 140, 5]], [0x10000649, [145, 25, 5, 5]], [0x1000064a, [145, 5, 5, 20]], [0x1000064b, [0, 0, 5, 5]],
  [0x1000064c, [5, 0, 140, 5]], [0x1000064d, [145, 0, 5, 5]], [0x1000064e, [0, 5, 5, 20]],
] as const);

for (const [era, features] of [['ac1999-retail', ERA_1999], ['eor', ERA_EOR], ['classic-dereth', ERA_CLASSIC]] as const) {
  const is1999 = era === 'ac1999-retail';
  describe(`indicator strip geometry, era ${era} (BUG.era-hidden-row-gaps, behavioral)`, () => {
    let H: GameUIFixture;
    beforeAll(async () => {
      H = await mountGameUI();
      const stub = stubLayoutRenderer(H);
      const doc = H.win.document;
      const stubRender = stub.render;
      // 0x21000071 as LayoutRenderer builds it: the root at (0,0) 150x30, its children at their DAT rects.
      stub.render = (id: number, parent: HTMLElement) => {
        if (id !== 0x21000071) return stubRender(id, parent);
        const h = stubRender(id, parent);
        const root = h.elements.get(0x10000610) as HTMLElement;
        Object.assign(root.style, { position: 'absolute', left: '0px', top: '0px', width: '150px', height: '30px' });
        for (const [cid, [x, y, w, hh]] of STRIP_RECTS) {
          const el = doc.createElement('div');
          el.dataset.elementId = `0x${cid.toString(16)}`;
          Object.assign(el.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
          root.appendChild(el);
          h.elements.set(cid, el);
        }
        return h;
      };
      H.ui.layoutRenderer = stub;
      H.ui.setUnsupportedFeatures(features);
      H.ui.uiManager.setScreen('game');
      H.ui.renderHUD();
    }, 60_000);
    afterAll(() => H?.teardown());

    const rect = (id: number): number[] => {
      const root = H.win.document.getElementById('hud-indicators') as HTMLElement;
      const el = root.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
      return [el.style.left, el.style.top, el.style.width, el.style.height].map((v) => parseFloat(v));
    };

    it(is1999
      ? 'no 20 px hole where the mini-game icon was: the logout X and the right border move left, the strip is 130 wide'
      : 'every icon and border on its DAT rect; the strip is 150 wide', () => {
      const container = H.win.document.getElementById('hud-indicators') as HTMLElement;
      expect(parseFloat(container.style.width)).toBe(is1999 ? 130 : 150);
      expect(rect(0x10000610)).toEqual([0, 0, is1999 ? 130 : 150, 30]);
      for (const [id, [x, y, w, h]] of STRIP_RECTS) {
        if (id === 0x100000f3) continue;
        const past = is1999 && x >= 125;              // wholly right of the hidden icon (105..125)
        const spans = is1999 && x <= 105 && x + w >= 125; // the top / bottom borders
        expect(rect(id), id.toString(16)).toEqual([past ? x - 20 : x, y, spans ? w - 20 : w, h]);
      }
      // The icons before it keep their places; the X sits right after burden.
      expect(rect(0x100000f7)[0]).toBe(85);
      expect(rect(0x100000fa)[0]).toBe(is1999 ? 105 : 125);
    });
  });
}

describe('the new 1999 absences (behavioral)', () => {
  it('a 1999 world lacks the Friends page and nether damage; end of retail has both', () => {
    for (const f of ['friendsPanel', 'netherDamage', 'afk', 'pkLite', 'squelchFilters', 'characterRestore'] as const) {
      expect(ERA_1999.has(f), f).toBe(true);
      expect(ERA_EOR.has(f), f).toBe(false);
    }
  });

  for (const [era, features] of [['ac1999-retail', ERA_1999], ['eor', ERA_EOR]] as const) {
    const is1999 = era === 'ac1999-retail';
    it(is1999 ? '1999: a pending-deletion character shows no RESTORE button' : 'end of retail: RESTORE is shown', async () => {
      const H = await mountGameUI();
      try {
        H.ui.setUnsupportedFeatures(features);
        H.ui.showCharacterSelect([{ id: '2', name: 'Doomed', level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 0, deleteTime: 5 }], 11);
        H.ui.selectScreen.selectCharacter(0);
        H.ui.renderCharacterSelect();
        const restore = [...H.container.querySelectorAll('button')]
          .find((b) => b.querySelector('[data-ac-run-text]')?.getAttribute('data-ac-run-text') === 'RESTORE') as HTMLElement | undefined;
        expect(restore).toBeDefined();
        expect(restore!.style.display === 'none').toBe(is1999);
      } finally { H.teardown(); }
    }, 60_000);
  }
});

/** Layout 0x21000030 pane 0x1000026b: intro, divider, name label + box, the four option rows, Create Fellowship. */
const CREATE_COLUMN_RECTS: ReadonlyMap<number, readonly [number, number, number, number]> = new Map([
  [0x1000026c, [8, 18, 284, 120]], [0x1000026d, [0, 191, 300, 9]], [0x1000026e, [0, 200, 148, 18]], [0x1000026f, [148, 200, 147, 18]],
  [0x10000270, [25, 225, 275, 14]], [0x10000271, [25, 239, 275, 14]], [0x10000272, [25, 253, 275, 14]], [0x10000273, [25, 267, 275, 14]],
  [0x10000274, [33, 298, 234, 33]],
] as const);

describe('fellowship pane: no Leader / Open / Disband buttons on a 1999 world (behavioral)', () => {
  const OWN = 0x50000001;
  const OTHER = 0x50000002;
  const fellow = (guid: number, name: string) => ({ guid, name, level: 20, healthCurrent: 50, healthMax: 50, staminaCurrent: 60, staminaMax: 60, manaCurrent: 40, manaMax: 40, shareLoot: true });
  const LEADERSHIP = [0x1000027b, 0x1000027d, 0x10000280];
  const OTHERS = [0x1000027c, 0x1000027e, 0x1000027f];

  async function renderPane(features: ReadonlySet<EraFeature>): Promise<{ H: GameUIFixture; shown: (id: number) => boolean }> {
    const H = await mountGameUI();
    const doc = H.win.document;
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const el = doc.createElement('div');
      el.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(el);
      return el;
    };
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, 0x10000291, 0x10000292, 0x1000054a]) elements.set(id, mk(root, id));
        const pane = elements.get(0x10000292)!;
        const inFrame = mk(pane, 0x10000275);
        for (const id of [0x10000276, 0x10000277, 0x10000278, 0x10000279, 0x1000027a]) mk(inFrame, id);
        for (const id of [...LEADERSHIP, ...OTHERS]) { const b = mk(inFrame, id); for (const s of [0x100002ce, 0x100002cf, 0x100002d0]) mk(b, s); }
        const empty = mk(pane, 0x1000026b);
        for (const id of [0x1000026c, 0x1000026d, 0x1000026e, 0x1000026f]) mk(empty, id);
        for (const id of [0x10000270, 0x10000271, 0x10000272, 0x10000273]) mk(mk(empty, id), 0x10000328);
        mk(empty, 0x10000274);
        // The create column's DAT rects (layout 0x21000030 pane 0x1000026b), as LayoutRenderer places them.
        for (const [id, [x, y, w, h]] of CREATE_COLUMN_RECTS) {
          const el = empty.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
          Object.assign(el.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: (id: number, parent: HTMLElement) => H.ui.layoutRenderer.renderPanel(id, parent),
    };
    H.ui.setUnsupportedFeatures(features);
    H.ui.setFellowshipData({
      fellowshipName: 'Fellows', leaderGuid: OWN, shareXP: true, evenShare: true, open: true, isLocked: false,
      fellows: [fellow(OWN, 'Me'), fellow(OTHER, 'Them')],
    });
    H.ui.socialTab = 'fellowship';
    H.ui.toggleSocialPanel();
    const shown = (id: number): boolean => {
      const el = (H.ui.socialPanel as HTMLElement).querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
      return !!el && el.style.display !== 'none';
    };
    return { H, shown };
  }

  it('1999: Quit / Recruit / Dismiss stay; Leader / Open / Disband are gone', async () => {
    const { H, shown } = await renderPane(ERA_1999);
    try {
      for (const id of LEADERSHIP) expect(shown(id), id.toString(16)).toBe(false);
      for (const id of OTHERS) expect(shown(id), id.toString(16)).toBe(true);
    } finally { H.teardown(); }
  }, 60_000);

  it('end of retail: all six buttons', async () => {
    const { H, shown } = await renderPane(ERA_EOR);
    try {
      for (const id of [...LEADERSHIP, ...OTHERS]) expect(shown(id), id.toString(16)).toBe(true);
    } finally { H.teardown(); }
  }, 60_000);

  for (const [era, features] of [['ac1999-retail', ERA_1999], ['eor', ERA_EOR], ['classic-dereth', ERA_CLASSIC]] as const) {
    const is1999 = era === 'ac1999-retail';
    it(is1999 ? '1999, no fellowship: no Automatically Accept checkbox (key and agent toggle refused too); the other three stay'
      : 'end of retail, no fellowship: all four option checkboxes', async () => {
      const { H, shown } = await renderPane(features);
      try {
        H.ui.setFellowshipData(null);
        H.ui.renderSocialPanel();
        expect(shown(0x10000271)).toBe(!is1999);
        for (const id of [0x10000270, 0x10000272, 0x10000273]) expect(shown(id), id.toString(16)).toBe(true);
        // BUG.era-hidden-row-gaps — no row-sized hole: on 1999 the rows below the hidden one and
        // Create Fellowship close up by its 14 px pitch; end of retail stays on the DAT rects exactly.
        const rect = (id: number): number[] => {
          const el = (H.ui.socialPanel as HTMLElement).querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
          return [el.style.left, el.style.top, el.style.width, el.style.height].map((v) => parseFloat(v));
        };
        for (const [id, [x, y, w, h]] of CREATE_COLUMN_RECTS) {
          const up = is1999 && y >= 253 ? 14 : 0;
          expect(rect(id), id.toString(16)).toEqual([x, y - up, w, h]);
        }
        if (is1999) {
          const tops = [0x10000270, 0x10000272, 0x10000273].map((id) => rect(id)[1]);
          expect(tops).toEqual([225, 239, 253]);
        }
        // A re-render (the pane is redrawn on every fellowship change) never shifts twice.
        H.ui.renderSocialPanel();
        expect(rect(0x10000273)[1]).toBe(is1999 ? 253 : 267);
        expect(hiddenBy(FEATURE_FELLOWSHIP_CONTROLS, features).has(0x10000271)).toBe(is1999);
        expect(hiddenBy(FEATURE_KEYBIND_ACTIONS, features).has(0x10000083)).toBe(is1999);
        const before = !!H.ui.optionsSettings.autoAcceptFellowshipRequests;
        const reply = H.ui.agentFellowshipAction('auto', before ? 'off' : 'on');
        if (is1999) {
          expect(reply).toMatch(/no automatic accepting/);
          expect(!!H.ui.optionsSettings.autoAcceptFellowshipRequests).toBe(before);
        } else {
          expect(!!H.ui.optionsSettings.autoAcceptFellowshipRequests).toBe(!before);
        }
      } finally { H.teardown(); }
    }, 60_000);
  }
});

describe('social panel on a 1999 world: Allegiance and Fellowship only (behavioral)', () => {
  async function render(features: ReadonlySet<EraFeature>): Promise<{ H: GameUIFixture; shown: (id: number) => boolean }> {
    const H = await mountGameUI();
    const doc = H.win.document;
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const el = doc.createElement('div');
      el.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(el);
      return el;
    };
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, 0x10000291, 0x10000292, 0x1000054a]) elements.set(id, mk(root, id));
        const pane = elements.get(0x1000054a)!;
        for (const id of [0x10000547, 0x1000054b, 0x1000054c]) { const b = mk(pane, id); for (const sl of [0x100002ce, 0x100002cf, 0x100002d0]) mk(b, sl); }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: (id: number, parent: HTMLElement) => H.ui.layoutRenderer.renderPanel(id, parent),
    };
    H.ui.setUnsupportedFeatures(features);
    H.ui.socialTab = 'squelch';
    H.ui.toggleSocialPanel();
    const shown = (id: number): boolean => {
      const el = (H.ui.socialPanel as HTMLElement).querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
      return !!el && el.style.display !== 'none';
    };
    return { H, shown };
  }

  it('1999: the Friends and Squelch tabs are gone (the restored Squelch page falls back to Fellowship)', async () => {
    const { H, shown } = await render(ERA_1999);
    try {
      // The 1999 social panel had Allegiance and Fellowship; nothing listed the squelched names
      // (kb client-behavior/squelch-list.md): @squelch / @unsquelch and the chat menu's Ignore stay.
      expect(H.ui.socialTab).toBe('fellowship');
      expect(shown(0x10000512)).toBe(false);
      expect(shown(0x1000053b)).toBe(false);
      for (const id of [0x1000028c, 0x1000028e]) expect(shown(id), id.toString(16)).toBe(true);
    } finally { H.teardown(); }
  }, 60_000);

  it('end of retail on its Squelch page: Squelch Account is there', async () => {
    const { H, shown } = await render(ERA_EOR);
    try {
      expect(H.ui.socialTab).toBe('squelch');
      expect(shown(0x1000054c)).toBe(true);
    } finally { H.teardown(); }
  }, 60_000);

  it('end of retail: every tab and button', async () => {
    const { H, shown } = await render(ERA_EOR);
    try {
      for (const id of [0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x1000054b, 0x1000054c, 0x10000547]) expect(shown(id), id.toString(16)).toBe(true);
    } finally { H.teardown(); }
  }, 60_000);
});

describe('fellowship rows show only what the roster carries (behavioral, every era)', () => {
  const OWN = 0x50000001;
  async function rows(fellows: Array<Record<string, unknown>>, share: { shareXP?: boolean; evenShare?: boolean }): Promise<{ H: GameUIFixture; vitals: string[]; stats: string[] }> {
    const H = await mountGameUI();
    const doc = H.win.document;
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const el = doc.createElement('div');
      el.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(el);
      return el;
    };
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, 0x10000291, 0x10000292, 0x1000054a]) elements.set(id, mk(root, id));
        const inFrame = mk(elements.get(0x10000292)!, 0x10000275);
        for (const id of [0x10000276, 0x10000277, 0x10000278, 0x10000279, 0x1000027a]) mk(inFrame, id);
        return {
          root, elements, setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: (id: number, parent: HTMLElement) => H.ui.layoutRenderer.renderPanel(id, parent),
    };
    H.ui.setFellowshipData({ fellowshipName: 'Band', leaderGuid: OWN, open: false, isLocked: false, ...share, selfGuid: OWN, fellows });
    H.ui.socialTab = 'fellowship';
    H.ui.toggleSocialPanel();
    const rowEls = [...(H.ui.socialPanel as HTMLElement).querySelectorAll('.fellow-row')] as HTMLElement[];
    const vitals = rowEls.map((r) => (r.querySelector('[data-fellow-vitals]') as HTMLElement).dataset.fellowVitals as string);
    const stats = rowEls.map((r) => (r.firstElementChild as HTMLElement).textContent ?? '');
    return { H, vitals, stats };
  }

  it('the 1999 roster (level and name only, no share flags): no vitals bars, the level without an XP share', async () => {
    const { H, vitals, stats } = await rows([{ guid: OWN, name: 'Me', level: 12, shareLoot: false }, { guid: OWN + 1, name: 'Them', level: 7, shareLoot: false }], {});
    try {
      expect(vitals).toEqual(['0', '0']);
      expect(stats[0]).toContain('12');
      expect(stats[0]).not.toContain('%');
      expect(H.ui.agentFellows()).toEqual([{ guid: OWN + 1, name: 'Them', health: { cur: 0, max: 0 }, stamina: { cur: 0, max: 0 }, mana: { cur: 0, max: 0 } }]);
    } finally { H.teardown(); }
  }, 60_000);

  it('an end-of-retail roster: three bars per fellow and LEVEL/XP%', async () => {
    const full = (guid: number, name: string) => ({ guid, name, level: 20, healthCurrent: 50, healthMax: 50, staminaCurrent: 60, staminaMax: 60, manaCurrent: 0, manaMax: 40, shareLoot: true });
    const { H, vitals, stats } = await rows([full(OWN, 'Me'), full(OWN + 1, 'Them')], { shareXP: true, evenShare: true });
    try {
      expect(vitals).toEqual(['3', '3']);
      expect(stats[0]).toMatch(/20.*%/);
    } finally { H.teardown(); }
  }, 60_000);
});

describe('Components page: the desired-level field goes with the rebuy book (behavioral)', () => {
  const WCID = 691;
  const SCID = 1;
  async function desiredField(features: ReadonlySet<EraFeature>): Promise<{ H: GameUIFixture; field: HTMLElement | null; input: HTMLInputElement | null; count: HTMLElement | null }> {
    const H = await mountGameUI();
    const doc = H.win.document;
    const ROW_IDS = [0x10000468, 0x10000469, 0x1000046a, 0x1000046b];
    H.ui.layoutRenderer = {
      render: (_id: number, parent: HTMLElement, opts: { subtreeElementId?: number }) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        const mk = (p: HTMLElement, id: number): HTMLElement => {
          const el = doc.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          p.appendChild(el);
          elements.set(id, el);
          return el;
        };
        const top = mk(root, opts.subtreeElementId ?? 0);
        if (opts.subtreeElementId === 0x100002a7) mk(top, 0x10000464);
        if (opts.subtreeElementId === 0x10000467) for (const id of ROW_IDS) mk(top, id);
        return { root, elements, setText: () => {}, setVisible: () => {}, setState: () => {}, resizeSubtree: () => {} };
      },
      getTextureDataURLWithAlpha: () => null,
    };
    H.ui.setUnsupportedFeatures(features);
    H.ui.componentScidByWcid = new Map([[WCID, SCID]]);
    H.ui.spellComponentTable = { components: new Map([[SCID, { category: 0, icon: 0, name: 'Lead Scarab' }]]) };
    H.ui.inventoryItems = [{ id: 0x80000001, name: 'Lead Scarab', weenieClassId: WCID, itemType: 0x1000, stackSize: 3 }];
    const panel = doc.createElement('div');
    Object.assign(panel.style, { width: '300px', height: '337px' });
    H.container.appendChild(panel);
    H.ui.renderComponentsTab(panel);
    const row = panel.querySelector('[data-comp-wcid]') as HTMLElement | null;
    return {
      H,
      field: row?.querySelector('[data-element-id="0x1000046b"]') as HTMLElement | null,
      input: row?.querySelector('input.ac-comp-desired') as HTMLInputElement | null,
      count: row?.querySelector('[data-element-id="0x1000046a"]') as HTMLElement | null,
    };
  }

  it('1999: no desired field (0x224 has no 1999 builder); the count stays', async () => {
    const { H, field, input, count } = await desiredField(ERA_1999);
    try {
      expect(field).toBeTruthy();
      expect(field!.style.display).toBe('none');
      expect(input).toBeNull();
      expect(count).toBeTruthy();
      expect(count!.style.display).not.toBe('none');
      expect([...hiddenBy(FEATURE_COMPONENT_CONTROLS, ERA_1999)]).toEqual([0x1000046b]);
    } finally { H.teardown(); }
  }, 60_000);

  it('end of retail: the editable desired field', async () => {
    const { H, field, input } = await desiredField(ERA_EOR);
    try {
      expect(field!.style.display).not.toBe('none');
      expect(input).toBeTruthy();
      expect(input!.value).toBe('0');
    } finally { H.teardown(); }
  }, 60_000);
});

describe('chat commands: an era lacking a feature does not offer its commands (behavioral)', () => {
  /** The real command table over a context that records every send and print; everything else answers nothing. */
  function system(withheld: Iterable<string>, gate?: LocalChatGate): { sys: CommandSystem<RetailCommandContext>; sent: number[]; printed: string[]; talk: string[] } {
    const sent: number[] = [];
    const printed: string[] = [];
    const talk: string[] = [];
    const sink = { writeUInt32: () => {}, writeInt32: () => {}, writeUInt16: () => {}, writeFloat: () => {} };
    const own: Record<string, unknown> = {
      print: (text: string) => { printed.push(text); },
      send: (type: number, write?: (w: unknown) => void) => {
        sent.push(type);
        if (type === GameActionType.Talk && write) write({ ...sink, writeString16: (t: string) => { talk.push(t); } });
        return true;
      },
      confirm: (_text: string, yes: () => void) => yes(),
      friends: () => [], globalSquelchTypes: () => new Set(), chatPose: () => null, talkFocus: () => 1,
      nowSeconds: () => 0, gender: () => 1, lastOutsideDeathCell: () => null,
      // As main.ts wires it: only where eraClientRules().chatToggle is 'local'.
      ...(gate ? { setLocalChatSquelched: (sq: boolean) => gate.set(sq) } : {}),
    };
    const ctx = new Proxy(own, { get: (t, k) => (typeof k === 'string' && k in t ? t[k] : () => undefined) }) as unknown as RetailCommandContext;
    return { sys: new CommandSystem(ctx, retailCommandEntries(), withheld), sent, printed, talk };
  }
  const WITHHELD_1999 = hiddenBy(FEATURE_COMMANDS, ERA_1999);
  /** A 1999 world's command system, as main.ts builds it. */
  const system1999 = () => system(WITHHELD_1999, eraClientRules(eraProfile('ac1999-retail')).chatToggle === 'local' ? new LocalChatGate() : undefined);

  it('end of retail and the classic eras withhold nothing', () => {
    for (const p of Object.values(ERA_PROFILES)) {
      if (p.id === 'ac1999-retail') continue;
      expect(hiddenBy(FEATURE_COMMANDS, unsupportedFeatures(p)).size, p.id).toBe(0);
    }
  });

  it('every withheld name is a real command-table entry', () => {
    const names = new Set(retailCommandEntries().map((e) => e.name));
    for (const n of WITHHELD_1999) expect(names.has(n), n).toBe(true);
  });

  it('1999: @afk sends no AFK action; the word falls through to the server as an unknown command does', () => {
    const r = system(WITHHELD_1999);
    r.sys.onChatCommand('@afk', 1);
    expect(r.sent).toEqual([GameActionType.Talk]);
    expect(r.talk).toEqual(['@afk']);
    const e = system([]);
    e.sys.onChatCommand('@afk', 1);
    expect(e.sent).toEqual([GameActionType.SetAfkMode]);
  });

  it('1999: no registered command sends an action the 1999 game lacks, whatever its arguments', () => {
    const r = system1999();
    const argSets = [[], ['x'], ['on'], ['off'], ['msg', 'hi'], ['list'], ['all'], ['Bob'], ['1'], ['open'], ['recall'], ['motd'], ['info', 'Bob']];
    let ran = 0;
    const offenders: string[] = [];
    for (const entry of r.sys.entries()) {
      if (!entry.handler) continue;
      for (const args of argSets) {
        r.sent.length = 0;
        try { r.sys.doCommand(['@' + entry.name, ...args].join(' '), 2); } catch { /* the stub context answers nothing; only the sends matter */ }
        ran++;
        for (const t of r.sent) if (absent1999FeatureOfAction(t)) offenders.push(`@${entry.name} ${args.join(' ')} → 0x${t.toString(16)} ${absent1999FeatureOfAction(t)}`);
      }
    }
    // @notell is a 1999 command too (kb ui-command-dispatch), with a different send: 1999's sent
    // 0x1EB, which no server handles (kb Communication/0x1EB), so a dropped 0x5B does what it did.
    // @chat is client-side on 1999 (BUG.ac1999-chat-toggle-local) and sends nothing.
    expect(offenders.filter((o) => !/^@notell /.test(o))).toEqual([]);
    expect(ran).toBeGreaterThan(500);
    // The same sweep on the end-of-retail table does reach them (the sweep can see a miss).
    const e = system([]);
    const reached = new Set<string>();
    for (const line of ['@afk', '@house open', '@pklite', '@allegiance motd', '@consent who', '@marketplace']) {
      e.sent.length = 0;
      e.sys.doCommand(line, 2);
      for (const t of e.sent) { const f = absent1999FeatureOfAction(t); if (f) reached.add(f); }
    }
    expect([...reached].sort()).toEqual(['afk', 'allegianceAdmin', 'consent', 'housing', 'pkLite', 'postLaunchRecalls']);
  });

  it('1999 @chat off / on: the client-side switch (UI_SetLocalChatSquelched @ 0x4d0470), nothing sent; end of retail asks the server', () => {
    const gate = new LocalChatGate();
    const r = system(WITHHELD_1999, gate);
    r.sys.onChatCommand('@chat off', 1);
    expect(r.sent).toEqual([]);
    expect(r.printed).toEqual(['Local chat is now squelched.']);
    expect(gate.isSquelched).toBe(true);
    expect(gate.hears(0x50000002)).toBe(false);
    expect(gate.hears(0)).toBe(true);
    r.sys.onChatCommand('@chat on', 1);
    expect(r.printed[1]).toBe('Local chat is no longer squelched.');
    expect(gate.hears(0x50000002)).toBe(true);
    r.printed.length = 0;
    r.sys.onChatCommand('@chat', 1);
    expect(r.printed).toEqual(['Please specify if you want chat text on or off.']);
    expect(r.sent).toEqual([]);
    const e = system([]);
    e.sys.onChatCommand('@chat off', 1);
    expect(e.sent).toEqual([GameActionType.ModifyGlobalSquelch]);
    expect(e.printed).toEqual([]);
  });

  it('the @chat rule per era: local on 1999 only', () => {
    for (const p of Object.values(ERA_PROFILES)) expect(eraClientRules(p).chatToggle, p.id).toBe(p.id === 'ac1999-retail' ? 'local' : 'server');
  });

  it('1999 @help: the list leaves out the house, fillcomps and allegiance groups; @help house is an unknown command', () => {
    const r = system(WITHHELD_1999);
    r.sys.onChatCommand('@help', 1);
    const list = r.printed.join('');
    expect(list).toContain('@help chatting');
    expect(list).toContain('@help death');
    for (const g of ['@help house', '@help fillcomps', '@help allegiances']) expect(list, g).not.toContain(g);
    r.printed.length = 0;
    r.sys.onChatCommand('@help house', 1);
    expect(r.printed).toEqual(['Unknown command']);
    r.printed.length = 0;
    r.sys.onChatCommand('@help commands', 1);
    const all = r.printed.join('');
    expect(all).toContain('@tell');
    expect(all).not.toMatch(/^@afk\b/m);
    expect(all).not.toMatch(/^@house\b/m);
  });

  it('end of retail @help is retail\'s text, unchanged', () => {
    const r = system([]);
    r.sys.onChatCommand('@help', 1);
    const list = r.printed.join('');
    for (const g of ['@help house', '@help fillcomps', '@help allegiances']) expect(list, g).toContain(g);
    expect(withoutWithheldLines('@a - x\n@help house - y\n', () => false)).toBe('@a - x\n@help house - y\n');
    expect(withoutWithheldLines('@a - x\n@help house - y\n@house open\n', (n) => n === 'house')).toBe('@a - x\n');
  });
});

describe('the Recklessness band follows the world\'s SkillTable (Jake, 2026-10-22)', () => {
  // GameUI's module needs the DOM globals: take its export from a mounted fixture.
  let M: GameUIFixture;
  beforeAll(async () => { M = await mountGameUI(); }, 60_000);
  afterAll(() => M?.teardown());
  const recklessnessBandVisible = (skills: Array<{ id: number; sac?: number }>, has?: boolean): boolean => M.mod.recklessnessBandVisible(skills, has);

  it('a world without the skill never shows it; with it (or no table yet), retail\'s rule (no record → shown)', () => {
    expect(recklessnessBandVisible([], false)).toBe(false);
    expect(recklessnessBandVisible([{ id: 50, sac: 3 }], false)).toBe(false);
    expect(recklessnessBandVisible([])).toBe(true);
    expect(recklessnessBandVisible([], true)).toBe(true);
    expect(recklessnessBandVisible([{ id: 50, sac: 1 }], true)).toBe(false);
    expect(recklessnessBandVisible([{ id: 50, sac: 2 }], true)).toBe(true);
  });

  it('the band is the data\'s, not a client rule: no era profile carries one', () => {
    for (const p of Object.values(ERA_PROFILES)) expect('powerBarRecklessnessBand' in eraClientRules(p), p.id).toBe(false);
  });

  // The band follows the world's SkillTable (Jake, 2026-10-22): end of retail has skill 50 and keeps
  // retail's rule; the 1999 table and every classic table (Dark Majesty included) lack it: no band.
  const REPO = resolve(__dirname, '..');
  const PORTALS: Array<[string, string, string, boolean]> = [
    ['end of retail', 'eor', DAT_PATHS.portal, true],
    ['1999', 'ac1999-retail', resolve(REPO, 'dat-sets/ac1999-retail/portal.dat'), false],
    ['classic Dereth 1.1 (Dark Majesty)', 'classic-dereth', resolve(REPO, 'dat-sets/classic-dereth-1.1/client_portal.dat'), false],
    ['classic Dereth 1.0', 'classic-dereth', resolve(REPO, 'dat-sets/classic-dereth-1.0/client_portal.dat'), false],
    ['customdm', 'classicace-customdm', resolve(REPO, 'dat-sets/classicace-customdm-1.60/client_portal.dat'), false],
    ['infiltration', 'classicace-infiltration', resolve(REPO, 'dat-sets/classicace-infiltration-1.9/client_portal.dat'), false],
  ];
  for (const [name, era, path, hasSkill] of PORTALS) {
    describe.skipIf(!existsSync(path))(`${name} (needs its portal.dat)`, () => {
      let table: SkillTable;
      beforeAll(() => {
        const db = openDat(path);
        if (path.includes('ac1999')) db.setOverlay(ac1999PortalOverlay());
        table = new SkillTable(new DatReader(db.getFileData(0x0e000004)!));
      });
      it(`${era}: SkillTable has Recklessness: ${hasSkill}; a no-record character's band: ${hasSkill}`, () => {
        expect(table.skills.has(50)).toBe(hasSkill);
        const skills = [...table.skills.keys()].filter((id) => id !== 50).map((id) => ({ id, sac: 2 }));
        expect(recklessnessBandVisible(skills, table.skills.has(50))).toBe(hasSkill);
        if (hasSkill) {
          // Retail's rule, unchanged: untrained hides it, trained shows it.
          expect(recklessnessBandVisible([{ id: 50, sac: 1 }], true)).toBe(false);
          expect(recklessnessBandVisible([{ id: 50, sac: 2 }], true)).toBe(true);
        }
      });
    });
  }

  it('GameUI: the melee power bar\'s band follows the world\'s SkillTable (behavioral)', () => {
    const H = M;
    H.ui.layoutRenderer = stubLayoutRenderer(H);
    const band: boolean[] = [];
    H.ui.showPowerBar('jump');
    const handle = H.ui.powerBarHandle;
    expect(handle).toBeTruthy();
    const setVisible = handle.setVisible;
    handle.setVisible = (id: number, on: boolean) => { if (id === 0x100005ee) band.push(on); return setVisible(id, on); };
    H.ui.skillTable = null; // not loaded yet: retail's rule (no record → shown)
    H.ui.showPowerBar('melee');
    H.ui.skillTable = { skills: new Map() }; // a 1999 / classic-shaped table: no skill 50
    H.ui.showPowerBar('melee');
    H.ui.skillTable = { skills: new Map([[50, {}]]) }; // end of retail's: retail's rule
    H.ui.showPowerBar('melee');
    expect(band).toEqual([true, false, true]);
  });
});
