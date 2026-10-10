/**
 * The retail chat-command dispatcher (chat/commands/CommandSystem.ts):
 * OnChatCommand @ 00581320, DoCommand @ 0057e2e0, DoChannelCommand @
 * 005774a0, ChannelSystem::GetChannelID @ 005cf1f0, PublicChat @ 005810f0 +
 * Pose @ 00580480, SendTurbineChat @ 0057db10. Spec: docs/retail-commands/.
 */
import { describe, it, expect } from 'vitest';
import { BinaryWriter, BinaryReader, GameActionType } from '@ac/network';
import {
  CommandSystem, getChannelId, type CoreCommandContext, type CommandEntry, type ChatPose, type TurbineRoom,
  NOT_A_VALID_COMMAND, CHAT_TYPE_COMMAND, CHAT_TYPE_EMOTE, ALL_WINDOWS, TalkFocus, sendTurbineChat, SpamMeter, isMessageSafe,
} from '../packages/renderer/src/chat/commands/CommandSystem.js';

interface Sent { type: number; bytes: Uint8Array }
interface Printed { text: string; chatType: number; window: number }

function fake(over: Partial<CoreCommandContext> = {}) {
  const sent: Sent[] = [];
  const printed: Printed[] = [];
  const motions: string[] = [];
  const turbine: Array<{ room: number; chatType: number; text: string }> = [];
  const poses: Record<string, ChatPose> = {
    wave: { command: 'Wave', myEmote: 'wave.', otherEmote: 'waves %p hand.' },
    nomotion: { command: 'NotAMotion', myEmote: 'ponder.', otherEmote: '' },
  };
  const ctx: CoreCommandContext = {
    print: (text, chatType, window) => { printed.push({ text, chatType, window }); },
    send: (type, write) => { const w = new BinaryWriter(64); write?.(w); sent.push({ type, bytes: w.toBuffer() }); return true; },
    talkFocus: () => TalkFocus.All,
    lastSpeakableTarget: () => 0,
    usingTurbineChat: () => true,
    turbineRoom: (room: TurbineRoom) => ({ allegiance: 11, general: 22, trade: 33, lfg: 44, roleplay: 55, society: 66, olthoi: 77 })[room],
    sendTurbineChat: (room, chatType, text) => { turbine.push({ room, chatType, text }); return true; },
    hearsAllegianceChat: () => true,
    isOlthoi: () => false,
    globalChannelName: (t) => (t === 1 ? 'Allegiance' : t === 2 ? 'General' : `type${t}`),
    chatPose: (name) => poses[name.toLowerCase()] ?? null,
    playPoseMotion: (cmd) => { if (cmd === 'NotAMotion') return false; motions.push(cmd); return true; },
    gender: () => 1,
    nowSeconds: () => 1000,
    ...over,
  };
  return { ctx, sent, printed, motions, turbine };
}

const str16 = (bytes: Uint8Array, offset = 0): string => new BinaryReader(bytes, offset).readString16();

describe('OnChatCommand prefixes', () => {
  it("'/' is '@': a table command runs with argv after the command word", () => {
    const f = fake();
    const seen: string[][] = [];
    const sys = new CommandSystem(f.ctx, [{ name: 'die', handler: (_r, argv) => { seen.push(argv); return true; }, help: 'HelpDie' }]);
    sys.onChatCommand('/die', 8);
    sys.onChatCommand('@DIE  now  please', 8);
    expect(seen).toEqual([[], ['now', 'please']]);
    expect(f.sent).toEqual([]);
  });
  it("':' and ';' become @emote", () => {
    const f = fake();
    const got: string[] = [];
    const sys = new CommandSystem(f.ctx, [{ name: 'emote', handler: (r, argv) => { got.push(`${r.command}|${argv.join(' ')}`); return true; }, help: 'HelpEmote' }]);
    sys.onChatCommand(':waves hello', 8);
    sys.onChatCommand(';  grins', 8);
    expect(got).toEqual(['emote|waves hello', 'emote|grins']);
  });
  it('a handler returning false prints "That is not a valid command." (0x1a, window 0)', () => {
    const f = fake();
    const sys = new CommandSystem(f.ctx, [{ name: 'join', handler: () => false, help: 'HelpJoinChat' }]);
    sys.onChatCommand('@join nowhere', 8);
    expect(f.printed).toEqual([{ text: NOT_A_VALID_COMMAND, chatType: CHAT_TYPE_COMMAND, window: ALL_WINDOWS }]);
  });
  it('the command word drops a trailing comma and matches any case', () => {
    const f = fake();
    let ran = 0;
    const sys = new CommandSystem(f.ctx, [{ name: 'tell', handler: () => { ran++; return true; }, help: 'HelpTell' }]);
    sys.onChatCommand('@TELL, Bob', 8);
    expect(ran).toBe(1);
  });
});

describe('DoCommand fallbacks', () => {
  it('an unknown command goes to the server as Talk with the whole line (ACE parses @ commands)', () => {
    const f = fake();
    const sys = new CommandSystem(f.ctx, []);
    sys.onChatCommand('/suicide', 8);
    sys.onChatCommand('@acecommands', 8);
    expect(f.sent.map((s) => [s.type, str16(s.bytes)])).toEqual([
      [GameActionType.Talk, '@suicide'],
      [GameActionType.Talk, '@acecommands'],
    ]);
    expect(f.printed).toEqual([]);
  });
  it('a group entry with no handler falls through the same way', () => {
    const f = fake();
    const sys = new CommandSystem(f.ctx, [{ name: 'death', handler: null, help: 'HelpDeathGroup' }]);
    sys.onChatCommand('@death', 8);
    expect(f.sent.map((s) => [s.type, str16(s.bytes)])).toEqual([[GameActionType.Talk, '@death']]);
  });
  it('a channel alias with text broadcasts (DoChannelCommand); without text it is Talk', () => {
    const f = fake();
    const sys = new CommandSystem(f.ctx, []);
    sys.onChatCommand('@celhan hello  there', 8);
    sys.onChatCommand('@sent', 8);
    expect(f.sent[0].type).toBe(GameActionType.ChatChannel);
    const r = new BinaryReader(f.sent[0].bytes);
    expect(r.readUInt32()).toBe(0x08000000);
    expect(r.readString16()).toBe('hello there');
    expect([f.sent[1].type, str16(f.sent[1].bytes)]).toEqual([GameActionType.Talk, '@sent']);
  });
  it('the Help channel is never broadcast by DoChannelCommand', () => {
    const f = fake();
    new CommandSystem(f.ctx, []).onChatCommand('@help me', 8);
    expect([f.sent[0].type, str16(f.sent[0].bytes)]).toEqual([GameActionType.Talk, '@help me']);
  });
  it('the first registration of a name wins unless replaced (StartupTurbineChatSystem re-registers a)', () => {
    const f = fake();
    const hits: string[] = [];
    const sys = new CommandSystem(f.ctx, [
      { name: 'a', handler: () => { hits.push('channel'); return true; }, help: null },
      { name: 'a', handler: () => { hits.push('dup'); return true; }, help: null },
    ]);
    sys.onChatCommand('@a hi', 8);
    sys.register({ name: 'a', handler: () => { hits.push('turbine'); return true; }, help: null }, true);
    sys.onChatCommand('@a hi', 8);
    expect(hits).toEqual(['channel', 'turbine']);
  });
});

describe('GetChannelID', () => {
  it('maps retail aliases case-insensitively', () => {
    expect(getChannelId('G')).toBe(0x800);
    expect(getChannelId('party')).toBe(0x800);
    expect(getChannelId('covassal')).toBe(0x01000000);
    expect(getChannelId('ab')).toBe(0x02000000);
    expect(getChannelId('radblo')).toBe(0x20000000);
    expect(getChannelId('ol')).toBe(0x40000000);
    expect(getChannelId('general')).toBe(0);
    expect(getChannelId('')).toBe(0);
  });
});

describe('talk: PublicChat and the talk focus', () => {
  it('plain text from the main chat follows the talk focus; other windows always PublicChat', () => {
    const f = fake({ talkFocus: () => TalkFocus.Fellows });
    const sys = new CommandSystem(f.ctx, []);
    sys.onChatCommand('hi all', 8);
    sys.onChatCommand('hi all', 0x10000);
    expect(f.sent[0].type).toBe(GameActionType.ChatChannel);
    expect(new BinaryReader(f.sent[0].bytes).readUInt32()).toBe(0x800);
    expect([f.sent[1].type, str16(f.sent[1].bytes)]).toEqual([GameActionType.Talk, 'hi all']);
  });
  it('Selected focus with no speakable target sends nothing', () => {
    const f = fake({ talkFocus: () => TalkFocus.Selected });
    new CommandSystem(f.ctx, []).onChatCommand('psst', 8);
    expect(f.sent).toEqual([]);
    const g = fake({ talkFocus: () => TalkFocus.Selected, lastSpeakableTarget: () => 0x50000002 });
    new CommandSystem(g.ctx, []).onChatCommand('psst', 8);
    expect(g.sent[0].type).toBe(GameActionType.TalkDirect);
  });
  it('foci 7–12 send chat type 1 gated on HearAllegianceChat (retail quirk); Olthoi sends type 10', () => {
    const f = fake({ talkFocus: () => TalkFocus.General });
    new CommandSystem(f.ctx, []).onChatCommand('wts sword', 8);
    expect(f.turbine).toEqual([{ room: 22, chatType: 1, text: 'wts sword' }]);
    const g = fake({ talkFocus: () => TalkFocus.General, hearsAllegianceChat: () => false });
    new CommandSystem(g.ctx, []).onChatCommand('wts sword', 8);
    expect(g.turbine).toEqual([]);
    expect(g.printed).toEqual([{ text: 'You are not listening to the Allegiance channel!\n', chatType: 0, window: 0 }]);
    const o = fake({ talkFocus: () => TalkFocus.Olthoi, isOlthoi: () => true });
    new CommandSystem(o.ctx, []).onChatCommand('skree', 8);
    expect(o.turbine).toEqual([{ room: 77, chatType: 10, text: 'skree' }]);
  });
  it('*pose* is performed and cut; the rest is said; "You <myEmote>" echoes as an emote line', () => {
    const f = fake();
    new CommandSystem(f.ctx, []).onChatCommand('hello *wave* friend', 8);
    expect(f.motions).toEqual(['Wave']);
    expect(f.sent.map((s) => [s.type, str16(s.bytes)])).toEqual([
      [GameActionType.SoulEmote, 'waves his hand.'],
      [GameActionType.Talk, 'hello  friend'],
    ]);
    expect(f.printed).toEqual([{ text: 'You wave.\n', chatType: CHAT_TYPE_EMOTE, window: 0 }]);
  });
  it('a pose-only line sends no Talk; an unknown *span* is spoken verbatim; <pose> works too; %p is her for gender 2', () => {
    const f = fake({ gender: () => 2 });
    const sys = new CommandSystem(f.ctx, []);
    sys.onChatCommand('<wave>', 8);
    sys.onChatCommand('*grins*', 8);
    expect(f.sent.map((s) => [s.type, str16(s.bytes)])).toEqual([
      [GameActionType.SoulEmote, 'waves her hand.'],
      [GameActionType.Talk, '*grins*'],
    ]);
  });
  it('a pose with no motion command still echoes but is not cut from the line', () => {
    const f = fake();
    new CommandSystem(f.ctx, []).onChatCommand('*nomotion*', 8);
    expect(f.printed.map((p) => p.text)).toEqual(['You ponder.\n']);
    expect(f.sent.map((s) => [s.type, str16(s.bytes)])).toEqual([[GameActionType.Talk, '*nomotion*']]);
  });
});

describe('SendTurbineChat', () => {
  it('unavailable, empty/unsafe, spam and failed-send branches use retail text', () => {
    const f = fake({ usingTurbineChat: () => false });
    expect(sendTurbineChat(f.ctx, new SpamMeter(), 22, 2, 'x', true)).toBe(false);
    expect(f.printed[0]).toEqual({ text: 'Turbine chat is not available.\n', chatType: 0, window: 0 });

    const g = fake();
    expect(sendTurbineChat(g.ctx, new SpamMeter(), 22, 2, '', true)).toBe(false);
    expect(sendTurbineChat(g.ctx, new SpamMeter(), 22, 2, 'hi <tell:x>', true)).toBe(false);
    expect(g.printed).toEqual([]);

    let t = 1000;
    const h = fake({ nowSeconds: () => t });
    const spam = new SpamMeter();
    expect(sendTurbineChat(h.ctx, spam, 22, 2, 'one', true)).toBe(true);
    expect(sendTurbineChat(h.ctx, spam, 22, 2, 'two', true)).toBe(false);
    expect(h.printed.at(-1)?.text).toBe('You must wait 0s before communicating again!');
    t += 5;
    expect(sendTurbineChat(h.ctx, spam, 22, 2, 'three', true)).toBe(true);

    const k = fake({ sendTurbineChat: () => false });
    expect(sendTurbineChat(k.ctx, new SpamMeter(), 22, 2, 'x', true)).toBe(false);
    expect(k.printed[0].text).toBe('Failed to send text to channel: General\n');
  });
  it('IsMessageSafe rejects <tell: in any case and newlines', () => {
    expect(isMessageSafe('hello')).toBe(true);
    expect(isMessageSafe('a <TELL:bob> b')).toBe(false);
    expect(isMessageSafe('a\nb')).toBe(false);
  });
});

describe('CommandRun', () => {
  it('reply prints to the command window with 0x1a by default; dispatch re-enters OnChatCommand from the same source', () => {
    const f = fake();
    const entries: CommandEntry<CoreCommandContext>[] = [
      { name: 'x', handler: (r) => { r.reply('usage'); r.dispatch('@y'); return true; }, help: null },
      { name: 'y', handler: (r) => { r.reply(`from ${r.source}`, 0); return true; }, help: null },
    ];
    new CommandSystem(f.ctx, entries).onChatCommand('@x', 0x10002);
    expect(f.printed).toEqual([
      { text: 'usage', chatType: CHAT_TYPE_COMMAND, window: 0x10002 },
      { text: 'from 65538', chatType: 0, window: 0x10002 },
    ]);
  });
});
