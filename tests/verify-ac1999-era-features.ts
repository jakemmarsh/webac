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
import { readFileSync } from 'node:fs';
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
  unsupportedFeatures, hiddenBy, FEATURE_KEYBIND_ACTIONS, FEATURE_CHARACTER_OPTIONS, FEATURE_TOOLBAR_BUTTONS, FEATURE_PANELS, FEATURE_EQUIP_SLOTS, type EraFeature,
} from '../packages/renderer/src/era/EraFeatures.js';
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

describe('era capability set', () => {
  it('a 1999 world lacks every absent feature plus the end-of-retail wcid tables, and nothing client-side', () => {
    for (const f of Object.keys(ABSENT_1999)) expect(ERA_1999.has(f as EraFeature), f).toBe(true);
    expect(ERA_1999.has('eolWcidTables')).toBe(true);
    // Every entry is an absent feature or one of those justified in EraFeatures.ts.
    const extra = [...ERA_1999].filter((f) => !(f in ABSENT_1999)).sort();
    expect(extra).toEqual(['cloaks', 'eolWcidTables', 'fishing', 'friendsPanel', 'netherDamage', 'rareGems', 'trinkets']);
    // BUG.ac1999-char-info-eor-rows sweep: no cloak or trinket slot on the 1999 paperdoll.
    expect([...hiddenBy(FEATURE_EQUIP_SLOTS, ERA_1999)].sort()).toEqual([EquipMask.TrinketOne, EquipMask.Cloak].sort());
    expect(hiddenBy(FEATURE_EQUIP_SLOTS, ERA_EOR).size).toBe(0);
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
    // 1999's own commands stay (Show/Hide Inventory, Run as Default Movement), and the retail dead ends stay hidden.
    expect(ui.has(0x10000019)).toBe(true);
    expect(cs.has(0x1000007b)).toBe(true);
    expect(ui.has(0x10000003)).toBe(false);
  });

  it('end of retail: every one of them is listed', () => {
    const ui = ids(ActionClass.UI);
    for (const id of [0x10000016, 0x10000017, 0x1000011a, 0x1000012e]) expect(ui.has(id), id.toString(16)).toBe(true);
    expect(ids(ActionClass.CharacterSettings).has(0x10000074)).toBe(true);
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
});

describe('social panel on a 1999 world: no Friends tab, no Squelch Account button (behavioral)', () => {
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

  it('1999: the Friends tab and Squelch Account are gone; Squelch Character / Remove stay', async () => {
    const { H, shown } = await render(ERA_1999);
    try {
      expect(shown(0x10000512)).toBe(false);
      expect(shown(0x1000054c)).toBe(false);
      for (const id of [0x1000028c, 0x1000028e, 0x1000053b, 0x1000054b, 0x10000547]) expect(shown(id), id.toString(16)).toBe(true);
    } finally { H.teardown(); }
  }, 60_000);

  it('end of retail: every tab and button', async () => {
    const { H, shown } = await render(ERA_EOR);
    try {
      for (const id of [0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x1000054b, 0x1000054c, 0x10000547]) expect(shown(id), id.toString(16)).toBe(true);
    } finally { H.teardown(); }
  }, 60_000);
});
