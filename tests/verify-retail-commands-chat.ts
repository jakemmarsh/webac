/**
 * The retail chat command group (chat/commands/ChatCommands.ts), driven through
 * the real CommandSystem: DoChatToggle, DoNoTell, DoReply, DoReTell, DoSay,
 * DoTell, DoAFK, DoStupidChannelHack, DoJoinChat/DoLeaveChat, DoChannelIndex/
 * List/On/Off and the StartupTurbineChatSystem DoTurbineChat_* handlers.
 * Spec: docs/retail-commands/chat.md.
 */
import { describe, it, expect } from 'vitest';
import { BinaryWriter, BinaryReader, GameActionType } from '@ac/network';
import {
  CommandSystem, type TurbineRoom, NOT_A_VALID_COMMAND, CHANNEL_DOES_NOT_EXIST, CHAT_TYPE_COMMAND, CHAT_TYPE_DEFAULT,
  ALL_WINDOWS, TalkFocus,
} from '../packages/renderer/src/chat/commands/CommandSystem.js';
import {
  chatCommandEntries, turbineChatCommandEntries, type ChatCommandContext, type HearChatRoom,
  HELP_AFK_DETAIL, NOT_IN_AN_ALLEGIANCE,
} from '../packages/renderer/src/chat/commands/ChatCommands.js';

interface Sent { type: number; bytes: Uint8Array }
interface Printed { text: string; chatType: number; window: number }

const SRC = 8;

function fake(over: Partial<ChatCommandContext> = {}) {
  const sent: Sent[] = [];
  const printed: Printed[] = [];
  const turbine: Array<{ room: number; chatType: number; text: string }> = [];
  const hear: Array<[HearChatRoom, boolean]> = [];
  const tellee: string[] = [];
  let now = 1000;
  const ctx: ChatCommandContext = {
    print: (text, chatType, window) => { printed.push({ text, chatType, window }); },
    send: (type, write) => { const w = new BinaryWriter(64); write?.(w); sent.push({ type, bytes: w.toBuffer() }); return true; },
    talkFocus: () => TalkFocus.All,
    lastSpeakableTarget: () => 0,
    usingTurbineChat: () => true,
    turbineRoom: (room: TurbineRoom) => ({ allegiance: 11, general: 22, trade: 33, lfg: 44, roleplay: 55, society: 66, olthoi: 77 })[room],
    sendTurbineChat: (room, chatType, text) => { turbine.push({ room, chatType, text }); return true; },
    hearsAllegianceChat: () => true,
    isOlthoi: () => true,
    globalChannelName: (t) => ['', 'Allegiance', 'General', 'Trade', 'LFG', 'Roleplay', 'Society'][t] ?? `type${t}`,
    chatPose: (name) => (name.toLowerCase() === 'wave' ? { command: 'Wave', myEmote: 'wave.', otherEmote: '' } : null),
    playPoseMotion: () => true,
    gender: () => 1,
    nowSeconds: () => (now += 10),
    lastTeller: () => 0x50000001,
    lastTelleeName: () => 'Bob',
    setLastTelleeName: (n) => { tellee.push(n); },
    isAfk: () => false,
    hearsChat: () => true,
    setHearChat: (room, on) => { hear.push([room, on]); },
    ...over,
  };
  const sys = new CommandSystem(ctx, chatCommandEntries());
  const run = (line: string) => sys.onChatCommand(line, SRC);
  return { ctx, sys, run, sent, printed, turbine, hear, tellee };
}

const reader = (b: Uint8Array) => new BinaryReader(b, 0);
const u32s = (b: Uint8Array) => { const r = reader(b); const out: number[] = []; while (r.position < b.length) out.push(r.readUInt32()); return out; };
const reply = (text: string, chatType = CHAT_TYPE_COMMAND): Printed => ({ text, chatType, window: SRC });
const invalid: Printed = { text: NOT_A_VALID_COMMAND, chatType: CHAT_TYPE_COMMAND, window: ALL_WINDOWS };

describe('the entry table', () => {
  it('covers every retail name with its Help* function', () => {
    const map = Object.fromEntries(chatCommandEntries().map((e) => [e.name, e]));
    const helps: Record<string, string | null> = {
      chat: 'HelpChatToggle', notell: 'HelpNoTell', reply: 'HelpReply', r: 'HelpReply', rp: 'HelpReply', mr: 'HelpReply', pr: 'HelpReply',
      retell: 'HelpReTell', rt: 'HelpReTell', say: 'HelpSay', s: 'HelpSay', tell: 'HelpTell', t: 'HelpTell', send: 'HelpTell',
      whisper: 'HelpTell', w: 'HelpTell', afk: 'HelpAFK', join: 'HelpJoinChat', leave: 'HelpLeaveChat', index: null, clist: null,
      on: null, off: null, chatting: 'HelpChattingGroup', channels: 'HelpChannelsGroup',
    };
    for (const n of ['a', 'co-vassals', 'covassals', 'covassal', 'c', 'fellowship', 'fellows', 'fellow', 'f', 'group', 'g', 'party', 'monarch', 'm', 'patron', 'p', 'vassals', 'vassal', 'v']) helps[n] = 'HelpStupidChannelHack';
    expect(Object.keys(map).sort()).toEqual(Object.keys(helps).sort());
    for (const [n, h] of Object.entries(helps)) expect(map[n].help, n).toBe(h);
    for (const n of ['mr', 'pr', 'chatting', 'channels']) expect(map[n].handler, n).toBeNull();
  });
  it('the Turbine chat entries', () => {
    const got = turbineChatCommandEntries().map((e) => `${e.name}:${e.help}`);
    expect(got).toEqual([
      'a:HelpTurbineChat_Allegiance', 'guild:HelpTurbineChat_Allegiance', 'gu:HelpTurbineChat_Allegiance',
      'general:HelpTurbineChat_General', 'cg:HelpTurbineChat_General', 'trade:HelpTurbineChat_Trade', 'ct:HelpTurbineChat_Trade',
      'lfg:HelpTurbineChat_LFG', 'clfg:HelpTurbineChat_LFG', 'roleplay:HelpTurbineChat_Roleplay', 'crp:HelpTurbineChat_Roleplay',
      'society:HelpTurbineChat_Society', 'soc:HelpTurbineChat_Society', 'olthoi:HelpTurbineChat_Olthoi', 'o:HelpTurbineChat_Olthoi',
    ]);
  });
});

describe('DoChatToggle (@chat)', () => {
  it('on/off → ModifyGlobalSquelch(0|1, Speech 2), any case', () => {
    const f = fake();
    f.run('@chat ON');
    f.run('/chat off');
    expect(f.sent.map((s) => [s.type, ...u32s(s.bytes)])).toEqual([[GameActionType.ModifyGlobalSquelch, 0, 2], [GameActionType.ModifyGlobalSquelch, 1, 2]]);
    expect(f.printed).toEqual([]);
  });
  it('wrong count / wrong word', () => {
    const f = fake();
    f.run('@chat');
    f.run('@chat on off');
    f.run('@chat maybe');
    expect(f.printed).toEqual([
      reply('Please specify if you want chat text on or off.'), reply('Please specify if you want chat text on or off.'), reply('Please specify on or off.'),
    ]);
    expect(f.sent).toEqual([]);
  });
  it('a failed send → "That is not a valid command."', () => {
    const f = fake({ send: () => false });
    f.run('@chat on');
    expect(f.printed).toEqual([invalid]);
  });
});

describe('DoNoTell (@notell)', () => {
  it('on → squelch Tell (1,3); off → (0,3); any other word counts as on (retail quirk)', () => {
    const f = fake();
    f.run('@notell on');
    f.run('@notell OFF');
    f.run('@notell banana');
    expect(f.sent.map((s) => u32s(s.bytes))).toEqual([[1, 3], [0, 3], [1, 3]]);
    expect(f.sent.every((s) => s.type === GameActionType.ModifyGlobalSquelch)).toBe(true);
  });
  it('needs exactly one word', () => {
    const f = fake();
    f.run('@notell');
    expect(f.printed).toEqual([reply('Please specify if you want tells on or off.')]);
    expect(f.sent).toEqual([]);
  });
});

describe('DoReply (@reply @r @rp)', () => {
  it('Event_TalkDirect(text, last teller guid)', () => {
    const f = fake();
    for (const n of ['reply', 'r', 'rp']) f.run(`@${n}   hi   there `);
    expect(f.sent).toHaveLength(3);
    for (const s of f.sent) {
      expect(s.type).toBe(GameActionType.TalkDirect);
      const r = reader(s.bytes);
      expect(r.readString16()).toBe('hi there');
      expect(r.readUInt32()).toBe(0x50000001);
    }
  });
  it('empty text, then no teller', () => {
    const f = fake({ lastTeller: () => 0 });
    f.run('@r');
    f.run('@r hello');
    expect(f.printed).toEqual([reply('You must specify the text you wish to say!'), reply('Someone must @tell you first!')]);
    expect(f.sent).toEqual([]);
  });
  it('@mr / @pr have no handler: channel alias lookup fails, so the whole line is Event_Talk', () => {
    const f = fake();
    f.run('@mr hi');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].type).toBe(GameActionType.Talk);
    expect(reader(f.sent[0].bytes).readString16()).toBe('@mr hi');
  });
});

describe('DoReTell (@retell @rt)', () => {
  it('Event_TalkDirectByName(text, last tellee)', () => {
    const f = fake();
    f.run('@retell yo  there');
    f.run('@rt again');
    expect(f.sent.map((s) => { const r = reader(s.bytes); return [s.type, r.readString16(), r.readString16()]; })).toEqual([
      [GameActionType.Tell, 'yo there', 'Bob'], [GameActionType.Tell, 'again', 'Bob'],
    ]);
    expect(f.tellee).toEqual([]);
  });
  it('empty text is silent (retail quirk); no tellee prints the hint', () => {
    const f = fake({ lastTelleeName: () => '' });
    f.run('@rt');
    expect(f.printed).toEqual([]);
    f.run('@rt hi');
    expect(f.printed).toEqual([reply('You must first provide a name using @tell')]);
    expect(f.sent).toEqual([]);
  });
});

describe('DoSay (@say @s)', () => {
  it('PublicChat: inline poses stripped, rest Event_Talk', () => {
    const f = fake();
    f.run('@say hello *wave* world');
    f.run('@s yo');
    const talks = f.sent.filter((s) => s.type === GameActionType.Talk).map((s) => reader(s.bytes).readString16());
    expect(talks).toEqual(['hello  world', 'yo']);
    expect(f.printed).toContainEqual({ text: 'You wave.\n', chatType: 0xc, window: ALL_WINDOWS });
  });
  it('empty text', () => {
    const f = fake();
    f.run('@say');
    expect(f.printed).toEqual([reply('You must specify the text you wish to say!')]);
    expect(f.sent).toEqual([]);
  });
});

describe('DoTell (@tell @t @send @whisper @w)', () => {
  const tells = (f: ReturnType<typeof fake>) => f.sent.map((s) => { const r = reader(s.bytes); return [s.type, r.readString16(), r.readString16()]; });
  it('name before the first comma, text trimmed, leading + stripped, SetLastTelleeName', () => {
    const f = fake();
    f.run('@tell +Bob Smith,  hi, you ');
    for (const n of ['t', 'send', 'whisper', 'w']) f.run(`@${n} Al,x`);
    expect(tells(f)).toEqual([
      [GameActionType.Tell, 'hi, you', 'Bob Smith'],
      ...Array(4).fill([GameActionType.Tell, 'x', 'Al']),
    ]);
    expect(f.tellee).toEqual(['Bob Smith', 'Al', 'Al', 'Al', 'Al']);
  });
  it('the name keeps a space before the comma (retail quirk); empty text still sends', () => {
    const f = fake();
    f.run('@tell Bob ,hi');
    f.run('@tell Bob,');
    expect(tells(f)).toEqual([[GameActionType.Tell, 'hi', 'Bob '], [GameActionType.Tell, '', 'Bob']]);
  });
  it('no comma, or a leading comma', () => {
    const f = fake();
    f.run('@tell Bob hi');
    f.run('@tell ,hi');
    f.run('@tell');
    expect(f.printed).toEqual(Array(3).fill(reply('Use comma after the name for targeted chat.')));
    expect(f.sent).toEqual([]);
  });
});

describe('DoAFK (@afk)', () => {
  it('none / on → SetAfkMode(1) only when not AFK', () => {
    const f = fake();
    f.run('@afk');
    f.run('@afk On');
    expect(f.sent.map((s) => [s.type, ...u32s(s.bytes)])).toEqual([[GameActionType.SetAfkMode, 1], [GameActionType.SetAfkMode, 1]]);
    const g = fake({ isAfk: () => true });
    g.run('@afk on');
    expect(g.sent).toEqual([]);
    expect(f.printed).toEqual([]);
  });
  it('off → SetAfkMode(0) only when AFK', () => {
    const f = fake({ isAfk: () => true });
    f.run('@afk off');
    expect(f.sent.map((s) => [s.type, ...u32s(s.bytes)])).toEqual([[GameActionType.SetAfkMode, 0]]);
    const g = fake();
    g.run('@afk off');
    expect(g.sent).toEqual([]);
  });
  it('msg <text> → SetAfkMessage(text + "\\n"), echo with chat type 0', () => {
    const f = fake();
    f.run('@afk msg  gone   fishing ');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].type).toBe(GameActionType.SetAfkMessage);
    expect(reader(f.sent[0].bytes).readString16()).toBe('gone fishing\n');
    expect(f.printed).toEqual([reply('New AFK message set: gone fishing\n', CHAT_TYPE_DEFAULT)]);
  });
  it('msg with nothing → empty SetAfkMessage, default-message echo', () => {
    const f = fake();
    f.run('@afk MSG');
    expect(reader(f.sent[0].bytes).readString16()).toBe('');
    expect(f.printed).toEqual([reply('New AFK message set: I am currently away from the keyboard.', CHAT_TYPE_DEFAULT)]);
  });
  it('msg is capped at 192 characters', () => {
    const f = fake();
    f.run(`@afk msg ${'x'.repeat(191)}`);
    f.run(`@afk msg ${'y'.repeat(192)}`);
    f.run(`@afk msg ${'z'.repeat(300)}`);
    expect(f.sent.map((s) => reader(s.bytes).readString16())).toEqual([
      'x'.repeat(191) + '\n', 'y'.repeat(192) + '\n', 'z'.repeat(192) + '\n',
    ]);
  });
  it('anything else prints the HelpAFK detail text', () => {
    const f = fake();
    f.run('@afk later');
    expect(f.printed).toEqual([reply(HELP_AFK_DETAIL, CHAT_TYPE_DEFAULT)]);
    expect(HELP_AFK_DETAIL.startsWith('@afk - Turns on AFK (away-from-keyboard) mode.')).toBe(true);
    expect(HELP_AFK_DETAIL.endsWith('Your custom AFK message is limited to 192 characters.\n')).toBe(true);
    expect(f.sent).toEqual([]);
  });
});

describe('DoStupidChannelHack (@a @c @f @m @p @v …)', () => {
  const ids: Record<string, number> = {
    a: 0x02000000, 'co-vassals': 0x01000000, covassals: 0x01000000, covassal: 0x01000000, c: 0x01000000,
    fellowship: 0x800, fellows: 0x800, fellow: 0x800, f: 0x800, group: 0x800, g: 0x800, party: 0x800,
    monarch: 0x4000, m: 0x4000, patron: 0x2000, p: 0x2000, vassals: 0x1000, vassal: 0x1000, v: 0x1000,
  };
  it('each alias → Event_ChannelBroadcast(its channel, joined words)', () => {
    for (const [name, id] of Object.entries(ids)) {
      const f = fake();
      f.run(`@${name}  hello   all`);
      expect(f.sent, name).toHaveLength(1);
      expect(f.sent[0].type).toBe(GameActionType.ChatChannel);
      const r = reader(f.sent[0].bytes);
      expect(r.readUInt32(), name).toBe(id);
      expect(r.readString16()).toBe('hello all');
    }
  });
  it('no text', () => {
    const f = fake();
    f.run('@f');
    expect(f.printed).toEqual([reply('You must specify the text you wish to broadcast!')]);
    expect(f.sent).toEqual([]);
  });
});

describe('DoJoinChat / DoLeaveChat', () => {
  it('each room word sets its Hear*Chat option (first word only, any case)', () => {
    const f = fake();
    f.run('@join allegiance extra');
    f.run('@join GENERAL');
    f.run('@join trade');
    f.run('@join lfg');
    f.run('@join roleplay');
    f.run('@join society');
    f.run('@leave soc');
    f.run('@leave Trade');
    expect(f.hear).toEqual([
      ['allegiance', true], ['general', true], ['trade', true], ['lfg', true], ['roleplay', true], ['society', true],
      ['society', false], ['trade', false],
    ]);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([]);
  });
  it('unknown or missing room → "That is not a valid command."', () => {
    const f = fake();
    f.run('@join');
    f.run('@leave olthoi');
    expect(f.printed).toEqual([invalid, invalid]);
    expect(f.hear).toEqual([]);
  });
});

describe('DoChannelIndex / DoChannelList / DoChannelOn / DoChannelOff', () => {
  it('@index → IndexChannels with no payload, arguments ignored', () => {
    const f = fake();
    f.run('@index whatever');
    expect(f.sent).toEqual([{ type: GameActionType.IndexChannels, bytes: new Uint8Array(0) }]);
  });
  it('@clist / @on / @off <alias> → the channel id (help accepted)', () => {
    const f = fake();
    f.run('@clist abuse');
    f.run('@on help');
    f.run('@off AV2');
    expect(f.sent.map((s) => [s.type, ...u32s(s.bytes)])).toEqual([
      [GameActionType.ListChannels, 1], [GameActionType.AddChannel, 0x400], [GameActionType.RemoveChannel, 0x10],
    ]);
  });
  it('wrong word count / unknown channel', () => {
    const f = fake();
    f.run('@clist');
    f.run('@on a b');
    f.run('@off nowhere');
    expect(f.printed).toEqual([
      reply('Please specify the channel name.'), reply('Please specify the channel name.'),
      { text: CHANNEL_DOES_NOT_EXIST, chatType: CHAT_TYPE_COMMAND, window: ALL_WINDOWS },
    ]);
    expect(f.sent).toEqual([]);
  });
});

describe('DoTurbineChat_* (StartupTurbineChatSystem)', () => {
  const withTurbine = (over: Partial<ChatCommandContext> = {}) => {
    const f = fake(over);
    for (const e of turbineChatCommandEntries()) f.sys.register(e, true);
    return f;
  };
  it('each name → SendTurbineChat(room, its chat type, joined words)', () => {
    const f = withTurbine();
    const cases: Array<[string, number, number]> = [
      ['a', 11, 1], ['guild', 11, 1], ['gu', 11, 1], ['general', 22, 2], ['cg', 22, 2], ['trade', 33, 3], ['ct', 33, 3],
      ['lfg', 44, 4], ['clfg', 44, 4], ['roleplay', 55, 5], ['crp', 55, 5], ['society', 66, 6], ['soc', 66, 6],
      ['olthoi', 77, 10], ['o', 77, 10],
    ];
    for (const [name] of cases) f.run(`@${name} hi  there`);
    expect(f.turbine).toEqual(cases.map(([, room, chatType]) => ({ room, chatType, text: 'hi there' })));
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([]);
  });
  it('`a` replaces the channel-hack `a` once registered', () => {
    const before = fake();
    before.run('@a hi');
    expect(before.sent.map((s) => s.type)).toEqual([GameActionType.ChatChannel]);
    expect(before.turbine).toEqual([]);
  });
  it('no words → failure 0x26 then the dispatcher line: "That is not a valid command." twice (retail quirk)', () => {
    const f = withTurbine();
    f.run('@general');
    expect(f.printed).toEqual([invalid, invalid]);
  });
  it('Allegiance with no room → "You are not in an allegiance!" then the invalid-command line', () => {
    const f = withTurbine({ turbineRoom: () => 0 });
    f.run('@a hi');
    expect(f.printed).toEqual([{ text: NOT_IN_AN_ALLEGIANCE, chatType: CHAT_TYPE_COMMAND, window: ALL_WINDOWS }, invalid]);
    expect(f.turbine).toEqual([]);
  });
  it('other rooms with no room fall to SendTurbineChat: "Turbine chat is not available." + invalid line', () => {
    const f = withTurbine({ turbineRoom: () => 0 });
    f.run('@trade wts');
    expect(f.printed).toEqual([{ text: 'Turbine chat is not available.\n', chatType: CHAT_TYPE_DEFAULT, window: ALL_WINDOWS }, invalid]);
  });
  it('each handler gates on its own Hear*Chat option (Olthoi on IsOlthoi)', () => {
    const asked: string[] = [];
    const f = withTurbine({
      hearsChat: (room) => { asked.push(room); return false; },
      hearsAllegianceChat: () => { asked.push('allegiance*'); return false; },
      isOlthoi: () => { asked.push('isOlthoi'); return false; },
    });
    for (const n of ['a', 'general', 'trade', 'lfg', 'roleplay', 'society', 'olthoi']) f.run(`@${n} x`);
    expect(asked).toEqual(['allegiance*', 'general', 'trade', 'lfg', 'roleplay', 'society', 'isOlthoi']);
    expect(f.printed.map((p) => p.text)).toEqual(['Allegiance', 'General', 'Trade', 'LFG', 'Roleplay', 'Society', 'type10']
      .map((n) => `You are not listening to the ${n} channel!\n`));
    expect(f.turbine).toEqual([]);
  });
});
