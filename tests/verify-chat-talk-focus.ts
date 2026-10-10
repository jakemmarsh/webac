/**
 * The main chat's talk focus and its "Chat" button menu (gmMainChatUI:
 * InitTalkFocusMenu @ 004cdc50, HandleSelection @ 004cd540, SetSelected
 * @ 004cd730; gmCCommunicationSystem::SetTalkFocusEnabled @ 00589080;
 * ClientCommunicationSystem::OnChatCommand @ 00581320).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ChatTalkFocusModel, TalkFocus, MENU_ITEMS, ITEM_STATE,
  talkFocusAllegianceEnables,
} from '../packages/renderer/src/ui/ChatTalkFocus.js';
import { BinaryWriter, BinaryReader, GameActionType } from '@ac/network';
import { CommandSystem, type CoreCommandContext, type TurbineRoom } from '../packages/renderer/src/chat/commands/CommandSystem.js';

/**
 * The retail command system reading this model the way main.ts wires it
 * (talkFocus → model.focus, lastSpeakableTarget → model.lastSpeakable):
 * OnChatCommand's talk-focus switch is CommandSystem.talkByFocus.
 */
function routedThrough(m: ChatTalkFocusModel) {
  const sent: Array<{ type: number; channel?: number }> = [];
  const turbine: number[] = [];
  const rooms: Record<TurbineRoom, number> = { allegiance: 1, general: 2, trade: 3, lfg: 4, roleplay: 5, society: 6, olthoi: 7 };
  const ctx = new Proxy({
    print: () => {},
    send: (type: number, write?: (w: BinaryWriter) => void) => {
      const w = new BinaryWriter(64); write?.(w);
      const r = new BinaryReader(w.toBuffer());
      sent.push(type === GameActionType.ChatChannel ? { type, channel: r.readUInt32() } : { type });
      return true;
    },
    talkFocus: () => m.focus,
    lastSpeakableTarget: () => m.lastSpeakable,
    usingTurbineChat: () => true,
    turbineRoom: (room: TurbineRoom) => rooms[room],
    sendTurbineChat: (room: number) => { turbine.push(room); return true; },
    hearsAllegianceChat: () => true,
    isOlthoi: () => true,
    chatPose: () => null,
    nowSeconds: () => turbine.length * 10,
  } as unknown as CoreCommandContext, { get: (t, k) => (t as never)[k] ?? (() => undefined) });
  const sys = new CommandSystem(ctx, []);
  return { say: (line: string) => sys.onChatCommand(line, 1), sent, turbine, rooms };
}
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

describe('ChatTalkFocusModel', () => {
  it('starts on Say with only Say allowed; a disabled pick is ignored', () => {
    const m = new ChatTalkFocusModel();
    expect(m.focus).toBe(TalkFocus.Say);
    expect(m.handleSelection(TalkFocus.Fellows)).toBe(false);
    expect(m.focus).toBe(TalkFocus.Say);
    const r = routedThrough(m);
    r.say('hello');
    expect(r.sent).toEqual([{ type: GameActionType.Talk }]);
  });

  it('routes each focus (through the retail dispatcher): fellowship/patron/monarch/vassals channels, turbine rooms', () => {
    const m = new ChatTalkFocusModel();
    for (const id of Object.values(TalkFocus)) m.setEnabled(id, true);
    const r = routedThrough(m);
    m.handleSelection(TalkFocus.Fellows); r.say('a');
    m.handleSelection(TalkFocus.Patron); r.say('b');
    m.handleSelection(TalkFocus.Monarch); r.say('c');
    m.handleSelection(TalkFocus.Vassals); r.say('d');
    expect(r.sent).toEqual([0x800, 0x2000, 0x4000, 0x1000].map((channel) => ({ type: GameActionType.ChatChannel, channel })));
    m.handleSelection(TalkFocus.Trade); r.say('e');
    expect(r.turbine).toEqual([r.rooms.trade]);
    m.handleSelection(TalkFocus.Allegiance);
    expect(m.wantsAllegianceChat).toBe(true);
    expect(m.buttonLabel().text).toBe('Alg');
  });

  it('SetSelected: a name allows Tell to Selected; losing it falls back to Say', () => {
    const m = new ChatTalkFocusModel();
    m.setSelected(0x50000002, 'Bob', false);
    expect(m.handleSelection(TalkFocus.Selected)).toBe(true);
    const r = routedThrough(m);
    r.say('hi');
    expect(r.sent).toEqual([{ type: GameActionType.TalkDirect }]);
    expect(m.lastSpeakable).toBe(0x50000002);
    expect(m.buttonLabel().text).toBe('Tell');
    m.setSelected(0, '', false);
    expect(m.focus).toBe(TalkFocus.Say);
    expect(m.isEnabled(TalkFocus.Selected)).toBe(false);
  });

  it('item states: pressed focus, greyed disabled, squelch pressed while squelched, Olthoi override', () => {
    const m = new ChatTalkFocusModel();
    const squelch = MENU_ITEMS[0];
    const say = MENU_ITEMS.find(i => i.focus === TalkFocus.Say)!;
    const gen = MENU_ITEMS.find(i => i.focus === TalkFocus.General)!;
    expect(m.itemState(say)).toBe(ITEM_STATE.pressed);
    expect(m.itemState(gen)).toBe(ITEM_STATE.disabled);
    expect(m.itemState(squelch)).toBe(ITEM_STATE.disabled);
    m.setSelected(0x50000002, 'Bob', true);
    expect(m.itemState(squelch)).toBe(ITEM_STATE.pressed);
    m.setEnabled(TalkFocus.General, true);
    expect(m.itemState(gen)).toBe(ITEM_STATE.normal);
    expect(m.itemState(gen, true)).toBe(ITEM_STATE.disabled);
  });

  it('only plain lines take the focus: / @ : ; lines are commands (OnChatCommand)', () => {
    const m = new ChatTalkFocusModel();
    m.setEnabled(TalkFocus.Fellows, true);
    m.handleSelection(TalkFocus.Fellows);
    const r = routedThrough(m);
    for (const t of ['@acecmd', '/acecmd', ':waves', ';waves']) r.say(t);
    // Unknown commands go out as Talk, the emotes as Emote — never the Fellow channel.
    expect(r.sent.some((x) => x.type === GameActionType.ChatChannel)).toBe(false);
    r.say('hello');
    expect(r.sent.at(-1)).toEqual({ type: GameActionType.ChatChannel, channel: 0x800 });
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI — the Chat button menu (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const labels: string[] = [];
  let button: HTMLElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    button = domWindow.document.createElement('div');
    container.appendChild(button);
    ui.chatHandle = { elements: new Map([[0x10000014, button]]), setText: (id: number, t: string) => { if (id === 0x10000015) labels.push(t); } };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const menu = (): HTMLElement | null => domWindow.document.querySelector('[data-talk-focus-menu]');
  const rows = (): HTMLElement[] => [...(menu()?.querySelectorAll<HTMLElement>('[data-talk-focus-item]') ?? [])];

  it('opens the 14-row popup upward over the button; a pick relabels the button and closes it', () => {
    ui.setTalkFocusEnabled(TalkFocus.Fellows, true);
    ui.toggleTalkFocusMenu();
    expect(rows().length).toBe(MENU_ITEMS.length);
    // Opens upward: the popup's bottom sits on the button's top.
    expect(menu()!.style.transform).toBe('translateY(-100%)');
    const fell = rows().find(r => r.dataset.talkFocusItem === String(TalkFocus.Fellows))!;
    fell.click();
    expect(ui.talkFocus.focus).toBe(TalkFocus.Fellows);
    expect(labels.at(-1)).toBe('Fell');
    expect(menu()).toBeNull();
  });

  it('greyed rows do nothing; losing the fellowship falls back to Say and relabels', () => {
    ui.toggleTalkFocusMenu();
    const lfg = rows().find(r => r.dataset.talkFocusItem === String(TalkFocus.Lfg))!;
    expect(lfg.dataset.acState).toBe('d');
    lfg.click();
    expect(ui.talkFocus.focus).toBe(TalkFocus.Fellows);
    ui.closeTalkFocusMenu();
    ui.setTalkFocusEnabled(TalkFocus.Fellows, false);
    expect(ui.talkFocus.focus).toBe(TalkFocus.Say);
    expect(labels.at(-1)).toBe('Chat');
  });

  it('the Selected and Squelch rows name the target; the squelch row toggles through the callback', () => {
    const toggles: unknown[] = [];
    ui.onToggleTalkSquelch = (...a: unknown[]) => toggles.push(a);
    ui.setTalkFocusTarget(0x50000002, 'Bob', false);
    ui.toggleTalkFocusMenu();
    const squelch = rows().find(r => r.dataset.talkFocusItem === 'squelch')!;
    expect(squelch.dataset.acState).toBe('1');
    squelch.click();
    expect(toggles).toEqual([[0x50000002, 'Bob', true]]);
  });
});

describe('talkFocusAllegianceEnables (gmAllegianceUI::UpdatePatronData @ 004917c0)', () => {
  const MONARCH = 0x5000000a, VASSAL = 0x5000000b, SUB = 0x5000000c;
  const members = (online = true) => [
    { guid: MONARCH, parentGuid: 0, isOnline: online },
    { guid: VASSAL, parentGuid: MONARCH, isOnline: true },
    { guid: SUB, parentGuid: VASSAL, isOnline: true },
  ];

  it('enables Patron when the patron is also the monarch (live 2026-10-03: a direct vassal could not Tell Patron)', () => {
    expect(talkFocusAllegianceEnables({ selfGuid: VASSAL, members: members() })).toEqual({ patron: true, monarch: true, vassals: true });
  });

  it('needs the patron logged in, and a monarch has no patron or monarch focus', () => {
    expect(talkFocusAllegianceEnables({ selfGuid: VASSAL, members: members(false) }).patron).toBe(false);
    expect(talkFocusAllegianceEnables({ selfGuid: MONARCH, members: members() })).toEqual({ patron: false, monarch: false, vassals: true });
  });

  it('a sub-vassal resolves its own patron, not the monarch', () => {
    const offlinePatron = [{ guid: MONARCH, parentGuid: 0, isOnline: true }, { guid: VASSAL, parentGuid: MONARCH, isOnline: false }, { guid: SUB, parentGuid: VASSAL, isOnline: true }];
    expect(talkFocusAllegianceEnables({ selfGuid: SUB, members: offlinePatron })).toEqual({ patron: false, monarch: true, vassals: false });
  });

  it('no allegiance enables nothing', () => {
    expect(talkFocusAllegianceEnables(null)).toEqual({ patron: false, monarch: false, vassals: false });
  });
});
