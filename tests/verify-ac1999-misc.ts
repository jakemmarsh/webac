/**
 * The 1999 adapter's remaining client actions and server messages
 * (packages/network/src/era1999/codecs/Misc1999.ts; docs/ac1999-support.md
 * "Client actions" / "Server messages"): every end-of-retail action the page
 * builds goes through the real adapter and comes out in the AC1999 server
 * reader's layout; every 1999 server message goes through it and is read by
 * our REAL ServerMessageHandler.
 */
import { describe, expect, it } from 'vitest';
import { ChatMessageType, SquelchMask } from '../packages/shared/src/index.js';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { ABSENT_1999, absent1999FeatureOfAction } from '../packages/network/src/era1999/Absent1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import {
  buildFriendsCommand1999, friendsCommand1999Plan, FriendsCommand1999,
} from '../packages/network/src/era1999/codecs/Misc1999.js';
import { Reader1999, Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  BinaryWriter, buildAddFriendPayload, buildAddShortcutPayload, buildAdvocateTeleportPayload, buildBookModifyPagePayload,
  buildCharacterDelete, buildFellowshipCreatePayload, buildModifyCharacterSquelchPayload, buildSetCharacterOptionPayload,
  buildSetCharacterOptionsPayload, deserializeMessage, serializeGameAction,
} from '../packages/network/src/MessageSerializer.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const SEQ = 9;
const PLAYER = 0x50000001;

function adapter() {
  const logs: string[] = [];
  return { a: new Adapter1999(codecs1999(), { account: 'acjs', log: (m) => logs.push(m) }), logs };
}
const act = (type: number, payload: Uint8Array = new Uint8Array(0)) => serializeGameAction(SEQ, type, payload);
const dw = (...v: number[]) => { const w = new BinaryWriter(4 * v.length + 4); for (const x of v) w.writeUInt32(x); return w.toBuffer(); };
const str16 = (s: string) => { const w = new BinaryWriter(8); w.writeString16(s); return w.toBuffer(); };
/** The one 1999 message an action becomes, with a reader past [0xF7B1][seq]. */
function out1(type: number, payload?: Uint8Array): { type: number; r: Reader1999; bytes: Uint8Array; group: number } {
  const { a, logs } = adapter();
  const res = a.outbound(act(type, payload));
  expect(logs).toEqual([]);
  expect(res).toHaveLength(1);
  const bytes = res![0].message;
  const r = new Reader1999(bytes);
  expect(r.u32()).toBe(0xf7b1);
  expect(r.u32()).toBe(SEQ);
  return { type: r.u32(), r, bytes, group: res![0].group };
}

describe('client actions: the AC1999 server reader\'s layout', () => {
  for (const [name, type, args] of [
    ['SetSingleCharacterOption', GameActionType.SetSingleCharacterOption, [0x10, 1]],
    ['SwearAllegiance', GameActionType.SwearAllegiance, [PLAYER]],
    ['BreakAllegiance', GameActionType.BreakAllegiance, [PLAYER]],
    ['FellowshipDismiss', GameActionType.FellowshipDismiss, [PLAYER]],
    ['FellowshipRecruit', GameActionType.FellowshipRecruit, [PLAYER]],
    ['FellowshipUpdateRequest', GameActionType.FellowshipUpdateRequest, [1]],
    ['BookData', GameActionType.BookData, [0x7000001]],
    ['BookAddPage', GameActionType.BookAddPage, [0x7000001]],
    ['BookDeletePage', GameActionType.BookDeletePage, [0x7000001, 2]],
    ['BookPageData', GameActionType.BookPageData, [0x7000001, 2]],
    ['AddChannel', GameActionType.AddChannel, [0x800]],
    ['RemoveChannel', GameActionType.RemoveChannel, [0x800]],
    ['ListChannels', GameActionType.ListChannels, [0x800]],
    ['IndexChannels', GameActionType.IndexChannels, []],
    ['RemoveShortCut', GameActionType.RemoveShortCut, [4]],
  ] as const) {
    it(`${name} (0x${type.toString(16)}) keeps its type and dwords`, () => {
      const { type: t, r } = out1(type, args.length ? dw(...args) : undefined);
      expect(t).toBe(type);
      expect(Array.from({ length: args.length }, () => r.u32())).toEqual(args);
      expect(r.remaining).toBe(0);
    });
  }

  it('SetSingleCharacterOption is the payload the CHANGE_PLAYER_OPTION case reads (option, value)', () => {
    const { r } = out1(GameActionType.SetSingleCharacterOption, buildSetCharacterOptionPayload(0x1b, true));
    expect([r.u32(), r.u32()]).toEqual([0x1b, 1]);
  });

  it('SetCharacterOptions → the one options dword the 1999 CHARACTER_OPTIONS case reads', () => {
    const payload = buildSetCharacterOptionsPayload({ options1: 0x50c4a542, options2: 0x1234, spellbookFilters: 0x3fff, gameplayOptions: new Uint8Array([1, 2, 3]) });
    const { type, r } = out1(GameActionType.SetCharacterOptions, payload);
    expect(type).toBe(0x1a1);
    expect(r.u32()).toBe(0x50c4a542);
    expect(r.remaining).toBe(0);
  });

  it('FellowshipCreate → the name alone, as an AcString (no shareXP)', () => {
    const { type, r } = out1(GameActionType.FellowshipCreate, buildFellowshipCreatePayload('Band', true));
    expect(type).toBe(0xa2);
    expect(r.acString()).toBe('Band');
    expect(r.remaining).toBe(0);
  });

  it('FellowshipQuit → opcode only; a disband is not sent and names the absent feature', () => {
    const { type, r } = out1(GameActionType.FellowshipQuit, dw(0));
    expect(type).toBe(0xa3);
    expect(r.remaining).toBe(0);
    const { a, logs } = adapter();
    expect(a.outbound(act(GameActionType.FellowshipQuit, dw(1)))).toBeNull();
    expect(logs.join()).toMatch(/disband.*fellowshipLeadership/);
  });

  it('BookModifyPage → book, page, AcString text', () => {
    const { type, r } = out1(GameActionType.BookModifyPage, buildBookModifyPagePayload(0x7000001, 3, 'Hello'));
    expect(type).toBe(0xab);
    expect([r.u32(), r.i32(), r.acString()]).toEqual([0x7000001, 3, 'Hello']);
    expect(r.remaining).toBe(0);
  });

  it('ModifyCharacterSquelch → 0x58 / 0x59 by name, 0x5A / 0x5B by id', () => {
    const cases: Array<[boolean, number, string, number]> = [[true, 0, 'Bob', 0x58], [false, 0, 'Bob', 0x59], [true, PLAYER, '', 0x5a], [false, PLAYER, '', 0x5b]];
    for (const [add, guid, name, want] of cases) {
      const { type, r } = out1(GameActionType.ModifyCharacterSquelch, buildModifyCharacterSquelchPayload(add, guid, name, ChatMessageType.AllChannels));
      expect(type).toBe(want);
      if (guid) expect(r.u32()).toBe(guid); else expect(r.acString()).toBe(name);
      expect(r.remaining).toBe(0);
    }
  });

  it('AddShortCut → index, object, u32 spell; past the 9-slot 1999 tray it is not sent', () => {
    const { type, r } = out1(GameActionType.AddShortCut, buildAddShortcutPayload(3, 0, 1234, 2));
    expect(type).toBe(0x19c);
    expect([r.u32(), r.u32(), r.u32()]).toEqual([3, 0, 1234]);
    const { a, logs } = adapter();
    expect(a.outbound(act(GameActionType.AddShortCut, buildAddShortcutPayload(9, PLAYER, 0, 0)))).toBeNull();
    expect(a.outbound(act(GameActionType.RemoveShortCut, dw(12)))).toBeNull();
    expect(logs).toHaveLength(2);
  });

  it('QueryAge / QueryBirth → the dword target the server reads (and ignores)', () => {
    for (const type of [GameActionType.QueryAge, GameActionType.QueryBirth]) {
      const { type: t, r } = out1(type, str16(''));
      expect(t).toBe(type);
      expect(r.u32()).toBe(0);
      expect(r.remaining).toBe(0);
    }
  });

  it('AdvocateTeleport → AcString label then the 32-byte Position', () => {
    const { type, r } = out1(GameActionType.AdvocateTeleport, buildAdvocateTeleportPayload('', 0x905c003c, 1, 2, 3));
    expect(type).toBe(0xd6);
    expect(r.acString()).toBe('');
    expect(r.u32()).toBe(0x905c003c);
    expect([r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()]).toEqual([1, 2, 3, 1, 0, 0, 0]);
    expect(r.remaining).toBe(0);
  });

  it('friends: AddFriend / RemoveAllFriends → the top-level 0xF7CD FriendsCommand; RemoveFriend by guid is not sent', () => {
    const { a, logs } = adapter();
    const add = a.outbound(act(GameActionType.AddFriend, buildAddFriendPayload('Alice')))!;
    const r = new Reader1999(add[0].message);
    expect([r.u32(), r.u32(), r.acString()]).toEqual([0xf7cd, FriendsCommand1999.Add, 'Alice']);
    const all = new Reader1999(a.outbound(act(GameActionType.RemoveAllFriends))![0].message);
    expect([all.u32(), all.u32(), all.acString()]).toEqual([0xf7cd, FriendsCommand1999.RemoveAll, '']);
    expect(a.outbound(act(GameActionType.RemoveFriend, dw(PLAYER)))).toBeNull();
    expect(logs.join()).toMatch(/by name/);
  });

  it('the page\'s FriendsCommand (1999 worlds only) → AcString name; the 1999 @friends rules', () => {
    const { a } = adapter();
    const r = new Reader1999(a.outbound(buildFriendsCommand1999(FriendsCommand1999.Remove, 'Bob'))![0].message);
    expect([r.u32(), r.u32(), r.acString()]).toEqual([0xf7cd, 2, 'Bob']);
    expect(r.remaining).toBe(0);
    expect(friendsCommand1999Plan('list', '')).toEqual({ command: 0, name: '' });
    expect(friendsCommand1999Plan('whatever', '')).toEqual({ command: 0, name: '' });
    expect(friendsCommand1999Plan('add', '+Bob  ')).toEqual({ command: 1, name: 'Bob' });
    expect(friendsCommand1999Plan('add', 'x'.repeat(40))!.name).toHaveLength(32);
    expect(friendsCommand1999Plan('add', '')).toBeNull();
    expect(friendsCommand1999Plan('remove', 'all')).toEqual({ command: 3, name: '' });
    expect(friendsCommand1999Plan('remove', 'All')).toEqual({ command: 2, name: 'All' });
  });

  it('CharacterDelete → FixedBlob28 account + slot (Client.cpp checks 0xBEEFBEEF, skips 24, reads the slot)', () => {
    const { a } = adapter();
    const res = a.outbound(buildCharacterDelete('acjs', 2))!;
    expect(res[0].group).toBe(6);
    const r = new Reader1999(res[0].message);
    expect(r.u32()).toBe(0xf655);
    expect(r.u32()).toBe(0xbeefbeef);
    expect(r.fixedName(24)).toBe('acjs');
    expect(r.i32()).toBe(2);
    expect(r.remaining).toBe(0);
  });
});

describe('every action the page can send has a 1999 codec or is a named absent feature', () => {
  // Server → client message types that share the enum; the page never sends them.
  const NOT_SENT = new Set([0xf745, 0xf747, 0xf74c, 0xf750, 0xf755, 0xf6ea, 0xf7c9]);
  it('no GameActionType falls through unnamed', () => {
    const c = codecs1999();
    const unhandled = Object.values(GameActionType)
      .filter((v): v is number => typeof v === 'number' && !NOT_SENT.has(v))
      .filter((v) => !c.outboundAction.has(v) && absent1999FeatureOfAction(v) === null)
      .map((v) => v.toString(16));
    expect(unhandled).toEqual([]);
  });

  it('a new absent feature is dropped with its name (PK Lite, AFK, account squelch)', () => {
    const { a, logs } = adapter();
    expect(a.outbound(act(GameActionType.EnterPkLite))).toBeNull();
    expect(a.outbound(act(GameActionType.SetAfkMode, dw(1)))).toBeNull();
    expect(a.outbound(act(GameActionType.ModifyAccountSquelch, dw(1, 0)))).toBeNull();
    expect(logs.map((l) => l.replace(/.*\((.*): not in the 1999 game\).*/, '$1'))).toEqual([
      ABSENT_1999.pkLite.note, ABSENT_1999.afk.note, ABSENT_1999.squelchFilters.note,
    ]);
  });
});

// ── Server → client ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recording(): { got: Record<string, any[]>; feed: (msgs: Uint8Array[]) => void } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const got: Record<string, any[]> = {};
  const rec = (k: string) => (d: unknown) => { (got[k] ??= []).push(d); };
  const h = new ServerMessageHandler();
  h.setHandlers({
    onFellowshipFullUpdate: rec('full'), onFellowshipUpdateFellow: rec('fellow'), onFellowshipQuit: rec('quit'),
    onFellowshipDismiss: rec('dismiss'), onFellowshipDisband: () => rec('disband')(null), onBookModifyPageResponse: rec('modify'),
    onBookAddPageResponse: rec('add'), onBookDeletePageResponse: rec('delete'), onBookPageData: rec('page'),
    onSetSquelchDB: rec('squelch'), onServerMessage: rec('line'), onAccountBanned: rec('banned'),
    onAccountBoot: rec('boot'), onCharacterDelete: () => rec('chardelete')(null),
  });
  const feed = (msgs: Uint8Array[]) => { for (const m of msgs) h.handleMessage(deserializeMessage(m)); };
  return { got, feed };
}
const wrapped = (type: number, body: (w: Writer1999) => void) => {
  const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(42).u32(type);
  body(w);
  return w.toBytes();
};
const flat = (op: number, body: (w: Writer1999) => void = () => {}) => { const w = new Writer1999().u32(op); body(w); return w.toBytes(); };
const fellow = (w: Writer1999, cp: number, level: number, name: string) => w.u16(cp).u16(level).acString(name);

describe('server messages: fellowship, books, squelch, account', () => {
  it('0xAF FellowshipUpdate (Fellowship::Pack 1999) → FellowshipFullUpdate with the roster, name and leader', () => {
    const { a, logs } = adapter();
    const { got, feed } = recording();
    feed(a.inbound(wrapped(0xaf, (w) => {
      w.u16(2).u16(16);
      w.u32(PLAYER); fellow(w, 10, 12, 'Me');
      w.u32(PLAYER + 1); fellow(w, 0, 7, 'Them');
      w.acString('Band').u32(PLAYER);
    }), 4));
    expect(logs).toEqual([]);
    const f = got.full[0].parsed;
    expect(f.fellowshipName).toBe('Band');
    expect(f.leaderGuid).toBe(PLAYER);
    expect(f.fellows.map((x: { guid: number; name: string; level: number }) => [x.guid, x.name, x.level])).toEqual([[PLAYER, 'Me', 12], [PLAYER + 1, 'Them', 7]]);
    expect(f.tableSize).toBe(16);
    // BUG.ac1999-eor-ui — the 1999 roster carries no vitals and no share flags: they read as absent
    // (FELLOW_FIELD_NOT_CARRIED), not 0, so the fellowship rows draw no bars and no XP share.
    for (const x of f.fellows) {
      for (const k of ['healthMax', 'staminaMax', 'manaMax', 'healthCurrent', 'staminaCurrent', 'manaCurrent']) expect(x[k], k).toBeUndefined();
    }
    expect(f.shareXP).toBeUndefined();
    expect(f.evenShare).toBeUndefined();
    expect(f.open).toBe(false);
  });

  it('0xB0 UpdateFellow → FellowshipUpdateFellow (Full); 0xA7 / 0xB1 / 0xB3 → quit / dismiss / disband', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    feed(a.inbound(wrapped(0xb0, (w) => { w.u32(PLAYER + 1); fellow(w, 0, 9, 'Them'); }), 4));
    expect(got.fellow[0].fellow).toMatchObject({ guid: PLAYER + 1, name: 'Them', level: 9 });
    expect(got.fellow[0].fellow.healthMax).toBeUndefined();
    expect(got.fellow[0].fellow.manaCurrent).toBeUndefined();
    expect(got.fellow[0].updateType).toBe(1);
    feed(a.inbound(wrapped(0xa7, (w) => w.u32(PLAYER + 1)), 4));
    feed(a.inbound(wrapped(0xb1, (w) => w.u32(PLAYER + 2)), 4));
    feed(a.inbound(wrapped(0xb3, () => {}), 4));
    expect(got.quit).toEqual([{ playerId: PLAYER + 1 }]);
    expect(got.dismiss).toEqual([{ playerId: PLAYER + 2 }]);
    expect(got.disband).toHaveLength(1);
  });

  it('book page responses 0xB5 / 0xB6 / 0xB7 keep their dwords; 0xB8 PageData1999 → the end-of-retail page', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    feed(a.inbound(wrapped(0xb5, (w) => w.u32(0x7000001).i32(2).u32(1)), 4));
    feed(a.inbound(wrapped(0xb6, (w) => w.u32(0x7000001).i32(3).u32(1)), 4));
    feed(a.inbound(wrapped(0xb7, (w) => w.u32(0x7000001).i32(1).u32(0)), 4));
    expect(got.modify).toEqual([{ bookGuid: 0x7000001, page: 2, success: true }]);
    expect(got.add).toEqual([{ bookGuid: 0x7000001, page: 3, success: true }]);
    expect(got.delete).toEqual([{ bookGuid: 0x7000001, page: 1, success: false }]);
    feed(a.inbound(wrapped(0xb8, (w) => w.u32(0x7000001).i32(0).u32(PLAYER).acString('Me').acString('').i32(1).acString('Page one')), 4));
    expect(got.page).toEqual([{ bookGuid: 0x7000001, pageIndex: 0, authorId: PLAYER, authorName: 'Me', ignoreAuthor: false, pageText: 'Page one' }]);
  });

  it('0x5A / 0x5B squelch add / remove → a full SetSquelchDB snapshot and the 1999 line, only on a change', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    feed(a.inbound(flat(0x5a, (w) => w.acString('Bob').u32(PLAYER + 5)), 4));
    feed(a.inbound(flat(0x5a, (w) => w.acString('Bob').u32(PLAYER + 5)), 4)); // already on: silent
    feed(a.inbound(flat(0x5a, (w) => w.acString('Cy').u32(PLAYER + 6)), 4));
    feed(a.inbound(flat(0x5b, (w) => w.acString('Bob').u32(PLAYER + 5)), 4));
    feed(a.inbound(flat(0x5b, (w) => w.acString('Bob').u32(PLAYER + 5)), 4)); // not on: silent
    expect(got.squelch.map((d: { entries: Array<{ name: string }> }) => d.entries.map((e) => e.name))).toEqual([['Bob'], ['Bob', 'Cy'], ['Cy']]);
    expect(got.squelch[0].entries[0]).toEqual({ name: 'Bob', mask: SquelchMask.AllChannels, account: false });
    expect(got.squelch[0].globalMask).toBe(0);
    expect(got.line.map((l: { message: string }) => l.message)).toEqual(['You have squelched Bob.', 'You have squelched Cy.', 'You have un-squelched Bob.']);
  });

  it('account messages pass through (GDLE leftovers in the end-of-retail layout); 0xF655 confirms a delete', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    const banned = new BinaryWriter(32); banned.writeUInt32(0xf7c1); banned.writeInt32(3600); banned.writeString16('Bye.');
    feed(a.inbound(banned.toBuffer(), 4));
    feed(a.inbound(flat(0xf7dc, (w) => w.u32(0)), 4));
    feed(a.inbound(flat(0xf655), 4));
    expect(got.banned).toEqual([{ secondsUntilExpiry: 3600, reason: 'Bye.' }]);
    expect(got.boot).toHaveLength(1);
    expect(got.chardelete).toHaveLength(1);
  });
});
