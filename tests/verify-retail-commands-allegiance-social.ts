/**
 * Retail allegiance / social chat commands (AllegianceSocialCommands.ts),
 * driven through the real CommandSystem dispatcher. Spec:
 * docs/retail-commands/allegiance-social.md.
 */
import { describe, expect, it } from 'vitest';
import { BinaryWriter, GameActionType } from '@ac/network';
import {
  CommandSystem,
  NOT_A_VALID_COMMAND,
} from '../packages/renderer/src/chat/commands/CommandSystem';
import {
  allegianceSocialCommandEntries,
  logTextTypeFromString,
  strtol0,
  type AllegianceSocialCommandContext,
  type FriendEntry,
} from '../packages/renderer/src/chat/commands/AllegianceSocialCommands';

interface Sent { type: GameActionType; bytes: number[] }
interface Printed { text: string; chatType: number; windowId: number }

function makeFake(opts: { friends?: FriendEntry[]; hears?: boolean; teller?: string; squelch?: string[] | null; sendOk?: boolean; serverFriends1999?: boolean } = {}) {
  const sent: Sent[] = [];
  const printed: Printed[] = [];
  const calls: string[] = [];
  let friends = opts.friends ?? [];
  let hears = opts.hears ?? true;
  const ctx: AllegianceSocialCommandContext = {
    print: (text, chatType, windowId) => { printed.push({ text, chatType, windowId }); },
    send: (type, write) => {
      const w = new BinaryWriter();
      write?.(w);
      sent.push({ type, bytes: [...w.toBuffer()] });
      return opts.sendOk ?? true;
    },
    talkFocus: () => 1,
    lastSpeakableTarget: () => 0,
    usingTurbineChat: () => false,
    turbineRoom: () => 0,
    sendTurbineChat: () => false,
    hearsAllegianceChat: () => hears,
    isOlthoi: () => false,
    globalChannelName: () => '',
    chatPose: () => null,
    playPoseMotion: () => false,
    gender: () => 1,
    nowSeconds: () => 0,
    setHearAllegianceChat: (on) => { calls.push(`hear:${on}`); hears = on; },
    friends: () => friends,
    clearFriends: () => { calls.push('clearFriends'); friends = []; },
    weenieError: (code) => { calls.push(`weenieError:0x${code.toString(16)}`); },
    sendFriendsOld: () => { calls.push('friendsOld'); return true; },
    lastTellerName: () => opts.teller ?? '',
    squelchEntries: () => (opts.squelch === undefined ? [] : opts.squelch),
    setChatWindowTitle: (id, title) => { calls.push(`title:${id}:${title}`); },
    ...(opts.serverFriends1999 ? { serverFriends1999: (sub: string, name: string) => { calls.push(`server1999:${sub}:${name}`); } } : {}),
  };
  const sys = new CommandSystem(ctx, allegianceSocialCommandEntries());
  const run = (line: string, source = 8) => sys.onChatCommand(line, source);
  return { sent, printed, calls, run, sys };
}

/** Expected payload bytes, written with a real BinaryWriter. */
function bytes(write: (w: BinaryWriter) => void): number[] {
  const w = new BinaryWriter();
  write(w);
  return [...w.toBuffer()];
}
const str = (s: string) => bytes((w) => w.writeString16(s));
const u32 = (v: number) => bytes((w) => w.writeUInt32(v));

const USAGE = 'Please see @help Allegiance for more information on how to use this command.';

describe('command table', () => {
  it('registers every retail name with its Help function', () => {
    const e = allegianceSocialCommandEntries();
    expect(e.map((x) => [x.name, x.help])).toEqual([
      ['allegiances', 'HelpAllegiancesGroup'], ['allegiance', 'HelpAllegiance'], ['all', 'HelpAllegiance'],
      ['ab', 'HelpAllegiance'], ['alh', 'HelpAllegiance'], ['ah', 'HelpAllegiance'], ['motd', 'HelpMotd'],
      ['speaker', 'HelpSpeaker'], ['friends', 'HelpFriends'], ['friends_add', 'HelpFriends'],
      ['friends_remove', 'HelpFriends'], ['squelch', 'HelpSquelch'], ['unsquelch', 'HelpSquelch'], ['title', 'HelpTitle'],
    ]);
    expect(e[0].handler).toBeNull();
  });

  it('@allegiances (group-only) falls through to Event_Talk', () => {
    const f = makeFake();
    f.run('@allegiances');
    expect(f.sent).toEqual([{ type: GameActionType.Talk, bytes: str('@allegiances') }]);
  });

  it('String16L payloads are length-prefixed and 4-byte padded', () => {
    expect(str('Bob')).toEqual([3, 0, 0x42, 0x6f, 0x62, 0, 0, 0]);
  });
});

describe('DoAllegiance', () => {
  it('no / unknown subcommand prints the usage line (0x1a, command window) and never "not valid"', () => {
    for (const line of ['@allegiance', '/all', '@allegiance frobnicate x']) {
      const f = makeFake();
      f.run(line, 5);
      expect(f.printed).toEqual([{ text: USAGE, chatType: 0x1a, windowId: 5 }]);
      expect(f.sent).toEqual([]);
    }
  });

  it('subcommand words are case-insensitive', () => {
    const f = makeFake();
    f.run('@ALL HoMeToWn extra words');
    expect(f.sent).toEqual([{ type: GameActionType.RecallAllegianceHometown, bytes: [] }]);
    expect(f.printed).toEqual([]);
  });

  it('hometown / ho send RecallAllegianceHometown; a failed send prints the usage line', () => {
    const f = makeFake();
    f.run('@allegiance ho');
    expect(f.sent.map((s) => s.type)).toEqual([GameActionType.RecallAllegianceHometown]);
    const g = makeFake({ sendOk: false });
    g.run('@allegiance hometown');
    expect(g.printed.map((p) => p.text)).toEqual([USAGE]);
  });

  describe('boot', () => {
    it('boots a name (type 0, command window)', () => {
      const f = makeFake();
      f.run('@allegiance boot +Bob Smith', 4);
      expect(f.printed).toEqual([{ text: 'Attempting to boot Bob Smith...\n', chatType: 0, windowId: 4 }]);
      expect(f.sent).toEqual([{ type: GameActionType.BreakAllegianceBoot, bytes: [...str('Bob Smith'), ...u32(0)] }]);
    });
    it('-account sets the flag and is cut with the following character', () => {
      const f = makeFake();
      f.run('@allegiance boot -account Bob');
      expect(f.printed[0].text).toBe('Attempting to boot Bob (Account)...\n');
      expect(f.sent[0].bytes).toEqual([...str('Bob'), ...u32(1)]);
      const g = makeFake();
      g.run('@allegiance boot Bob -account');
      expect(g.sent[0].bytes).toEqual([...str('Bob'), ...u32(1)]);
    });
    it('retail quirk: "-account" alone passes the empty check and sends an empty name', () => {
      const f = makeFake();
      f.run('@allegiance boot -account');
      expect(f.printed[0].text).toBe('Attempting to boot  (Account)...\n');
      expect(f.sent[0].bytes).toEqual([...str(''), ...u32(1)]);
    });
    it('empty name', () => {
      const f = makeFake();
      f.run('@allegiance boot');
      expect(f.printed).toEqual([{ text: 'Please specify an actual name.', chatType: 0x1a, windowId: 8 }]);
      expect(f.sent).toEqual([]);
    });
  });

  it('info', () => {
    const f = makeFake();
    f.run('@allegiance info +Bob');
    expect(f.sent).toEqual([{ type: GameActionType.AllegianceInfoRequest, bytes: str('Bob') }]);
    const g = makeFake();
    g.run('@allegiance info');
    expect(g.printed.map((p) => [p.text, p.chatType])).toEqual([['Please specify an actual name.', 0x1a]]);
    expect(g.sent).toEqual([]);
  });

  describe('chat / ch', () => {
    it('on / off toggle HearAllegianceChat only when it changes, silently', () => {
      const f = makeFake({ hears: true });
      f.run('@allegiance chat on');
      f.run('@allegiance ch OFF');
      f.run('@allegiance chat off');
      expect(f.calls).toEqual(['hear:false']);
      expect(f.printed).toEqual([]);
      expect(f.sent).toEqual([]);
    });
    it('kick: default reason, comma split, untrimmed name (retail quirk)', () => {
      const f = makeFake();
      f.run('@allegiance chat kick Bob');
      expect(f.sent).toEqual([{ type: GameActionType.AllegianceChatBoot, bytes: [...str('Bob'), ...str('No reason given.')] }]);
      const g = makeFake();
      g.run('@allegiance chat kick +Bob , spamming  chat');
      expect(g.sent[0].bytes).toEqual([...str('+Bob '), ...str('spamming chat')]);
      const h = makeFake();
      h.run('@allegiance chat kick');
      expect(h.sent[0].bytes).toEqual([...str(''), ...str('No reason given.')]);
    });
    it('gag / ungag (JoinArgs: "+" kept)', () => {
      const f = makeFake();
      f.run('@allegiance chat gag +Bob');
      f.run('@allegiance chat ungag Bob');
      expect(f.sent).toEqual([
        { type: GameActionType.AllegianceChatGag, bytes: [...str('+Bob'), ...u32(1)] },
        { type: GameActionType.AllegianceChatGag, bytes: [...str('Bob'), ...u32(0)] },
      ]);
      const g = makeFake();
      g.run('@allegiance chat gag');
      g.run('@allegiance chat ungag');
      expect(g.printed.map((p) => p.text)).toEqual(['Please specify an actual name.', 'Please specify an actual name.']);
      expect(g.sent).toEqual([]);
    });
    it('unknown or missing word → usage line', () => {
      const f = makeFake();
      f.run('@allegiance chat');
      f.run('@allegiance chat loud');
      expect(f.printed.map((p) => p.text)).toEqual([USAGE, USAGE]);
    });
  });

  describe('broadcast / br and @ab', () => {
    it('sends ChannelBroadcast 0x02000000 with no echo', () => {
      const f = makeFake();
      f.run('@allegiance br hello  all');
      f.run('@allegiance broadcast x');
      f.run('@ab hi there');
      expect(f.sent).toEqual([
        { type: GameActionType.ChatChannel, bytes: [...u32(0x02000000), ...str('hello all')] },
        { type: GameActionType.ChatChannel, bytes: [...u32(0x02000000), ...str('x')] },
        { type: GameActionType.ChatChannel, bytes: [...u32(0x02000000), ...str('hi there')] },
      ]);
      expect(f.printed).toEqual([]);
    });
    it('empty text: usage line via @allegiance, "not valid" via @ab', () => {
      const f = makeFake();
      f.run('@allegiance br');
      expect(f.printed.map((p) => p.text)).toEqual([USAGE]);
      const g = makeFake();
      g.run('@ab');
      expect(g.printed).toEqual([{ text: NOT_A_VALID_COMMAND, chatType: 0x1a, windowId: 0 }]);
      expect(g.sent).toEqual([]);
    });
  });

  describe('ban', () => {
    it('list / add / remove', () => {
      const f = makeFake();
      f.run('@allegiance ban list');
      f.run('@allegiance ban add +Bob');
      f.run('@allegiance ban REMOVE Bob');
      expect(f.sent).toEqual([
        { type: GameActionType.ListAllegianceBans, bytes: [] },
        { type: GameActionType.AddAllegianceBan, bytes: str('Bob') },
        { type: GameActionType.RemoveAllegianceBan, bytes: str('Bob') },
      ]);
    });
    it('retail quirk: empty name is reported before the subcommand is validated', () => {
      const f = makeFake();
      f.run('@allegiance ban');
      f.run('@allegiance ban bogus');
      expect(f.printed.map((p) => p.text)).toEqual(['Please specify an actual name.', 'Please specify an actual name.']);
      const g = makeFake();
      g.run('@allegiance ban bogus Bob');
      expect(g.printed.map((p) => p.text)).toEqual([USAGE]);
      expect(g.sent).toEqual([]);
    });
  });

  describe('officer', () => {
    it('list (bare or "list"), clear, remove', () => {
      const f = makeFake();
      f.run('@allegiance officer');
      f.run('@allegiance officer list');
      f.run('@allegiance officer clear');
      f.run('@allegiance officer remove +Bob');
      expect(f.sent).toEqual([
        { type: GameActionType.ListAllegianceOfficers, bytes: [] },
        { type: GameActionType.ListAllegianceOfficers, bytes: [] },
        { type: GameActionType.ClearAllegianceOfficers, bytes: [] },
        { type: GameActionType.RemoveAllegianceOfficer, bytes: str('Bob') },
      ]);
      const g = makeFake();
      g.run('@allegiance officer remove');
      expect(g.printed.map((p) => [p.text, p.chatType])).toEqual([['Please specify the name of an allegiance member.', 0x1a]]);
    });
    it('set / add with strtol levels', () => {
      const f = makeFake();
      f.run('@allegiance officer set 2 Bob Jones');
      f.run('@allegiance officer add 0x3 Bob');
      expect(f.sent).toEqual([
        { type: GameActionType.SetAllegianceOfficer, bytes: [...str('Bob Jones'), ...u32(2)] },
        { type: GameActionType.SetAllegianceOfficer, bytes: [...str('Bob'), ...u32(3)] },
      ]);
    });
    it('bad level is checked before the name; empty name after a good level', () => {
      const f = makeFake();
      f.run('@allegiance officer set');
      f.run('@allegiance officer set 4 Bob');
      f.run('@allegiance officer set 2');
      expect(f.printed.map((p) => p.text)).toEqual([
        'Please specify a valid officer level as a number between 1 and 3. Check the game help files for more information on officer levels.',
        'Please specify a valid officer level as a number between 1 and 3. Check the game help files for more information on officer levels.',
        'Please specify the name of an allegiance member.',
      ]);
      expect(f.sent).toEqual([]);
    });
    it('unknown word → usage', () => {
      const f = makeFake();
      f.run('@allegiance officer promote Bob');
      expect(f.printed.map((p) => p.text)).toEqual([USAGE]);
    });
  });

  describe('title', () => {
    it('list / clear / set (no empty check on the title)', () => {
      const f = makeFake();
      f.run('@allegiance title');
      f.run('@allegiance title list');
      f.run('@allegiance title clear');
      f.run('@allegiance title set 1 High Lord');
      f.run('@allegiance title set 3');
      expect(f.sent).toEqual([
        { type: GameActionType.ListAllegianceOfficerTitles, bytes: [] },
        { type: GameActionType.ListAllegianceOfficerTitles, bytes: [] },
        { type: GameActionType.ClearAllegianceOfficerTitles, bytes: [] },
        { type: GameActionType.SetAllegianceOfficerTitle, bytes: [...u32(1), ...str('High Lord')] },
        { type: GameActionType.SetAllegianceOfficerTitle, bytes: [...u32(3), ...str('')] },
      ]);
    });
    it('bad level text; "add" is not an alias (usage line)', () => {
      const f = makeFake();
      f.run('@allegiance title set 0 X');
      f.run('@allegiance title add 1 X');
      expect(f.printed.map((p) => p.text)).toEqual(['Please specify a valid officer level as a number between 1 and 3.', USAGE]);
      expect(f.sent).toEqual([]);
    });
  });

  it('motd through @allegiance', () => {
    const f = makeFake();
    f.run('@allegiance motd');
    f.run('@allegiance motd set Hello');
    f.run('@allegiance motd bogus');
    expect(f.sent.map((s) => s.type)).toEqual([GameActionType.QueryMotd, GameActionType.SetMotd]);
    expect(f.printed.map((p) => p.text)).toEqual([USAGE]);
  });

  it('name: query / set (trim, "+" kept, empty sent) / clear / unknown', () => {
    const f = makeFake();
    f.run('@allegiance name');
    f.run('@allegiance name set +My Clan');
    f.run('@allegiance name set');
    f.run('@allegiance name clear');
    f.run('@allegiance name zap');
    expect(f.sent).toEqual([
      { type: GameActionType.QueryAllegianceName, bytes: [] },
      { type: GameActionType.SetAllegianceName, bytes: str('+My Clan') },
      { type: GameActionType.SetAllegianceName, bytes: str('') },
      { type: GameActionType.ClearAllegianceName, bytes: [] },
    ]);
    expect(f.printed.map((p) => p.text)).toEqual([USAGE]);
  });

  it('lock: every action', () => {
    const f = makeFake();
    for (const l of ['', ' off', ' on', ' toggle', ' check', ' bypass', ' bypass CLEAR']) f.run(`@allegiance lock${l}`);
    f.run('@allegiance lock bypass +Bob');
    f.run('@allegiance lock open');
    expect(f.sent).toEqual([
      ...[4, 1, 2, 3, 4, 5, 6].map((a) => ({ type: GameActionType.DoAllegianceLockAction, bytes: u32(a) })),
      { type: GameActionType.SetAllegianceApprovedVassal, bytes: str('Bob') },
    ]);
    expect(f.printed.map((p) => p.text)).toEqual([USAGE]);
  });

  it('house: fewer than two words checks status; pairs; bad pair → usage', () => {
    const f = makeFake();
    f.run('@allegiance house');
    f.run('@allegiance house guest');
    f.run('@allegiance house guest open');
    f.run('@allegiance house GUEST close');
    f.run('@allegiance house storage open now');
    f.run('@allegiance house storage close');
    f.run('@allegiance house guest lock');
    expect(f.sent.map((s) => s.bytes)).toEqual([1, 1, 2, 3, 4, 5].map(u32));
    expect(f.sent.every((s) => s.type === GameActionType.DoAllegianceHouseAction)).toBe(true);
    expect(f.printed.map((p) => p.text)).toEqual([USAGE]);
  });
});

describe('@alh / @ah', () => {
  it('recall with no args; refuse args', () => {
    const f = makeFake();
    f.run('@ah');
    f.run('/alh');
    f.run('@ah now', 3);
    expect(f.sent.map((s) => s.type)).toEqual([GameActionType.RecallAllegianceHometown, GameActionType.RecallAllegianceHometown]);
    expect(f.printed).toEqual([{ text: 'This command takes no arguments!', chatType: 0x1a, windowId: 3 }]);
  });
  it('a failed send gives "That is not a valid command."', () => {
    const f = makeFake({ sendOk: false });
    f.run('@ah');
    expect(f.printed.map((p) => p.text)).toEqual([NOT_A_VALID_COMMAND]);
  });
});

describe('@motd', () => {
  it('query / set (untrimmed, empty allowed) / clear', () => {
    const f = makeFake();
    f.run('@motd');
    f.run('@motd set Welcome  home');
    f.run('@motd set');
    f.run('@motd CLEAR');
    expect(f.sent).toEqual([
      { type: GameActionType.QueryMotd, bytes: [] },
      { type: GameActionType.SetMotd, bytes: str('Welcome home') },
      { type: GameActionType.SetMotd, bytes: str('') },
      { type: GameActionType.ClearMotd, bytes: [] },
    ]);
    expect(f.printed).toEqual([]);
  });
  it('unknown subcommand → "That is not a valid command."', () => {
    const f = makeFake();
    f.run('@motd show');
    expect(f.printed).toEqual([{ text: NOT_A_VALID_COMMAND, chatType: 0x1a, windowId: 0 }]);
  });
});

it('@speaker prints the retired-command line (type 0) and sends nothing', () => {
  const f = makeFake();
  f.run('@speaker anything', 6);
  expect(f.printed).toEqual([{ text: 'This command is no longer in use, please see @allegiance officer.\n', chatType: 0, windowId: 6 }]);
  expect(f.sent).toEqual([]);
});

describe('@friends on a 1999 world (the server holds the list)', () => {
  it('hands every subcommand to the server hook and never touches the local list or sends EoL actions', () => {
    const f = makeFake({ friends: [{ id: 1, name: 'Alice', online: true }], serverFriends1999: true });
    f.run('@friends');
    f.run('@friends add Some Body');
    f.run('@friends remove Alice');
    f.run('@friends ONLINE');
    expect(f.calls).toEqual(['server1999::', 'server1999:add:Some Body', 'server1999:remove:Alice', 'server1999:online:']);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([]);
  });
});

describe('@friends', () => {
  const list: FriendEntry[] = [
    { id: 0x50000001, name: 'Alice', online: true },
    { id: 0x50000002, name: '+Bob', online: false },
  ];

  it('lists all friends (type 0, window 0)', () => {
    const f = makeFake({ friends: list });
    f.run('@friends', 5);
    expect(f.printed).toEqual([
      { text: 'Your friends:\n', chatType: 0, windowId: 0 },
      { text: '  Alice (Online)\n', chatType: 0, windowId: 0 },
      { text: '  +Bob\n', chatType: 0, windowId: 0 },
    ]);
    expect(f.sent).toEqual([]);
  });
  it('online only, and nobody online', () => {
    const f = makeFake({ friends: list });
    f.run('@friends ONLINE');
    expect(f.printed.map((p) => p.text)).toEqual(['Your friends:\n', '  Alice (Online)\n']);
    const g = makeFake({ friends: [list[1]] });
    g.run('@friends online');
    expect(g.printed.map((p) => p.text)).toEqual(['Your friends:\n', '  You have no friends that are online.\n']);
  });
  it('empty list', () => {
    const f = makeFake();
    f.run('@friends online');
    expect(f.printed.map((p) => p.text)).toEqual(['Your friends list is empty!\n']);
  });
  it('old → FriendsOld control message', () => {
    const f = makeFake();
    f.run('@friends old');
    expect(f.calls).toEqual(['friendsOld']);
    expect(f.printed).toEqual([]);
  });
  it('invalid subcommand', () => {
    const f = makeFake();
    f.run('@friends dance', 4);
    expect(f.printed).toEqual([{ text: 'Invalid friends command specified.', chatType: 0x1a, windowId: 4 }]);
  });

  it('add (both spellings) sends AddFriend with the name', () => {
    const f = makeFake({ friends: list });
    f.run('@friends add +Carol');
    f.run('@friends_add Dave  Smith');
    expect(f.sent).toEqual([
      { type: GameActionType.AddFriend, bytes: str('Carol') },
      { type: GameActionType.AddFriend, bytes: str('Dave Smith') },
    ]);
  });
  it('add: empty name; 50-friend cap → weenie error 0x561', () => {
    const f = makeFake();
    f.run('@friends_add');
    expect(f.printed).toEqual([{ text: 'You must specify the name of the friend you wish to add.', chatType: 0x1a, windowId: 8 }]);
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `F${i}`, online: false }));
    const g = makeFake({ friends: many });
    g.run('@friends add Zed');
    expect(g.calls).toEqual(['weenieError:0x561']);
    expect(g.sent).toEqual([]);
    const h = makeFake({ friends: many.slice(0, 49) });
    h.run('@friends add Zed');
    expect(h.sent.map((s) => s.type)).toEqual([GameActionType.AddFriend]);
  });
  it('remove sends the matching friend\'s guid ("+" trimmed, any case)', () => {
    const f = makeFake({ friends: list });
    f.run('@friends remove bob');
    f.run('@friends_remove +ALICE');
    expect(f.sent).toEqual([
      { type: GameActionType.RemoveFriend, bytes: u32(0x50000002) },
      { type: GameActionType.RemoveFriend, bytes: u32(0x50000001) },
    ]);
  });
  it('remove: unknown → weenie error 0x563; empty name', () => {
    const f = makeFake({ friends: list });
    f.run('@friends remove Zed');
    expect(f.calls).toEqual(['weenieError:0x563']);
    expect(f.sent).toEqual([]);
    f.run('@friends_remove');
    expect(f.printed.map((p) => [p.text, p.chatType])).toEqual([['You must specify the name of the friend you wish to remove.', 0x1a]]);
  });
  it('remove -all clears the server and local lists and confirms', () => {
    const f = makeFake({ friends: list });
    f.run('@friends remove -ALL');
    expect(f.sent).toEqual([{ type: GameActionType.RemoveAllFriends, bytes: [] }]);
    expect(f.calls).toEqual(['clearFriends']);
    expect(f.printed).toEqual([{ text: 'Your friends list has been cleared.\n', chatType: 0, windowId: 0 }]);
  });
});

describe('@squelch / @unsquelch', () => {
  const charSquelch = (add: number, name: string, type: number) =>
    ({ type: GameActionType.ModifyCharacterSquelch, bytes: [...u32(add), ...u32(0), ...str(name), ...u32(type)] });

  it('bare: the squelch list (type 0, window 0)', () => {
    const f = makeFake({ squelch: [] });
    f.run('@squelch');
    expect(f.printed).toEqual([{
      text: '(account) denotes a character whose account has also been squelched.\nFormat: Name : List of squelched message types.\n--------\nnone\n',
      chatType: 0, windowId: 0,
    }]);
    const g = makeFake({ squelch: ['Name: Bob All message types', 'X'] });
    g.run('@unsquelch');
    expect(g.printed[0].text.endsWith('--------\n\n  Name: Bob All message types\n  X\n')).toBe(true);
    const h = makeFake({ squelch: null });
    h.run('@squelch');
    expect(h.printed.map((p) => p.text)).toEqual([NOT_A_VALID_COMMAND]);
  });

  it('name with default type All (1); unsquelch sends add=0', () => {
    const f = makeFake();
    f.run('@squelch +Bob');
    f.run('@unsquelch Bob Jones');
    expect(f.sent).toEqual([charSquelch(1, 'Bob', 1), charSquelch(0, 'Bob Jones', 1)]);
  });

  it('category flags (last wins, case-insensitive)', () => {
    const f = makeFake();
    f.run('@squelch -tell -COMBAT Bob');
    expect(f.sent).toEqual([charSquelch(1, 'Bob', 6)]);
  });

  it('-account sends ModifyAccountSquelch (type dropped)', () => {
    const f = makeFake();
    f.run('@squelch -account -tell Bob');
    expect(f.sent).toEqual([{ type: GameActionType.ModifyAccountSquelch, bytes: [...u32(1), ...str('Bob')] }]);
  });

  it('-reply uses the last teller and ignores other words', () => {
    const f = makeFake({ teller: 'Teller' });
    f.run('@squelch -reply Bob');
    expect(f.sent).toEqual([charSquelch(1, 'Teller', 1)]);
  });

  it('retail quirk: -reply with no teller / no target print and STILL send an empty name', () => {
    const f = makeFake();
    f.run('@squelch -reply');
    f.run('@unsquelch -chat');
    expect(f.printed.map((p) => [p.text, p.chatType])).toEqual([
      ['A player must @tell you before you can squelch them with this command.', 0x1a],
      ['"-chat" is not a valid squelch category.', 0x1a],
    ]);
    expect(f.sent).toEqual([charSquelch(1, '', 1)]);
    const g = makeFake();
    g.run('@squelch -magic');
    expect(g.printed.map((p) => p.text)).toEqual(['You have not specified a squelch target.']);
    expect(g.sent).toEqual([charSquelch(1, '', 7)]);
  });

  it('LogTextTypeFromString covers the retail names', () => {
    expect(logTextTypeFromString('assessment')).toBe(0x10);
    expect(logTextTypeFromString('Admin_Tell')).toBe(0x1f);
    expect(logTextTypeFromString('default')).toBe(0);
    expect(logTextTypeFromString('chat')).toBeNull();
  });
});

describe('@title', () => {
  it('refuses the main chat sources 1 and 8 (type 0)', () => {
    for (const src of [1, 8]) {
      const f = makeFake();
      f.run('@title My Window', src);
      expect(f.printed).toEqual([{ text: 'This command must be issued from a popup chat window.', chatType: 0, windowId: src }]);
      expect(f.calls).toEqual([]);
    }
  });
  it('retitles the popup window it was typed in', () => {
    const f = makeFake();
    f.run('@title Trade  Talk', 3);
    expect(f.calls).toEqual(['title:3:Trade Talk']);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([]);
  });
  it('empty title; 98 chars accepted, 99 refused (retail quirk)', () => {
    const f = makeFake();
    f.run('@title', 3);
    f.run(`@title ${'a'.repeat(99)}`, 3);
    f.run(`@title ${'a'.repeat(98)}`, 3);
    expect(f.printed.map((p) => [p.text, p.chatType])).toEqual([
      ['You must provide a new title for the window.', 0],
      ['Window title length cannot exceed 100 characters.', 0],
    ]);
    expect(f.calls).toEqual([`title:3:${'a'.repeat(98)}`]);
  });
});

it('strtol base 0', () => {
  expect(strtol0('2')).toBe(2);
  expect(strtol0('0x3')).toBe(3);
  expect(strtol0('02')).toBe(2);
  expect(strtol0('3abc')).toBe(3);
  expect(strtol0('')).toBe(0);
  expect(strtol0('-1')).toBe(-1);
  expect(strtol0('x')).toBe(0);
});
