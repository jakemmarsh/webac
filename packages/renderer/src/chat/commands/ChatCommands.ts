/**
 * The retail chat group of chat commands: @chat, @notell, @reply, @retell,
 * @say, @tell, @afk, the channel-alias broadcasts (DoStupidChannelHack),
 * @join / @leave, the advocate channel commands (@index, @clist, @on, @off)
 * and the Turbine chat-room commands StartupTurbineChatSystem @ 0057efb0
 * registers once Turbine chat starts (@a, @general, @trade, @lfg, …).
 *
 * Ported from the decompiled EoL client (ClientCommunicationSystem); the
 * spec with every string, chat type and decomp line is
 * docs/retail-commands/chat.md. Line numbers below refer to
 * reference/client-eol/decomp/acclient-decompiled.annotated.c.
 */
import { GameActionType } from '@ac/network';
import {
  type CoreCommandContext, type CommandEntry, type CommandRun, type TurbineRoom,
  ALL_WINDOWS, CHAT_TYPE_COMMAND, CHAT_TYPE_DEFAULT, CHANNEL_DOES_NOT_EXIST, CHANNEL_HELP, NOT_A_VALID_COMMAND,
  TurbineChatType, channelBroadcast, eventTalkDirect, getChannelId, joinArgs, joinArgsAsName, publicChat, sameWord,
  sendTurbineChat,
} from './CommandSystem.js';

/** The Turbine chat rooms with a PlayerModule Hear*Chat option bit (Olthoi has none). */
export type HearChatRoom = Exclude<TurbineRoom, 'olthoi'>;

/** What the chat group needs beyond the dispatcher's own context. */
export interface ChatCommandContext extends CoreCommandContext {
  /** gmCCommunicationSystem::GetLastTeller: guid of the last player who @tell'd you (0 = none). */
  lastTeller(): number;
  /** gmCCommunicationSystem::GetLastTelleeName: the last name you @tell'd ("" = none). */
  lastTelleeName(): string;
  /** gmCCommunicationSystem::SetLastTelleeName. */
  setLastTelleeName(name: string): void;
  /** PlayerDesc InqBool(0x6e) (PropertyBool.Afk). */
  isAfk(): boolean;
  /**
   * PlayerModule::HearGeneralChat / HearTradeChat / HearLFGChat / HearRoleplayChat /
   * HearSocietyChat (CharacterOptions2 0x100/0x200/0x400/0x800/0x80000), and
   * HearAllegianceChat (CharacterOptions1 0x40000000) for 'allegiance'.
   */
  hearsChat(room: HearChatRoom): boolean;
  /**
   * PlayerModule::SetHear{Allegiance,General,Trade,LFG,Roleplay,Society}Chat:
   * flip that option bit (retail then runs the PlayerModule options-changed slot,
   * which persists the options and re-enables the talk foci).
   */
  setHearChat(room: HearChatRoom, on: boolean): void;
  /**
   * The era's client keeps @chat on the client (eraClientRules().chatToggle 'local', the 1999
   * client.exe): set its local-speech flag (chat/LocalChatGate.ts) and return the line to print.
   * Absent (end of retail): @chat asks the server.
   */
  setLocalChatSquelched?(squelched: boolean): string;
}

type Run = CommandRun<ChatCommandContext>;

/** PStringBase::trim(whitespace) on both ends. */
const trimWs = (s: string): string => s.replace(/^\s+|\s+$/g, '');

// ── Event_* serializers (CM_Communication; payloads as ACE reads them) ──

/** Event_ModifyGlobalSquelch 0x5B: squelch u32, ChatMessageType u32. */
function modifyGlobalSquelch(run: Run, squelch: number, chatMessageType: number): boolean {
  return run.ctx.send(GameActionType.ModifyGlobalSquelch, (w) => { w.writeUInt32(squelch); w.writeUInt32(chatMessageType); });
}

/** Event_TalkDirectByName 0x5D: text String16L, target name String16L. */
function talkDirectByName(run: Run, text: string, name: string): boolean {
  return run.ctx.send(GameActionType.Tell, (w) => { w.writeString16(text); w.writeString16(name); });
}

// ── handlers ──

/** DoChatToggle @ 0056fad0 (decomp 357715–357750): @chat on|off squelches Speech (ChatMessageType 2). */
function doChatToggle(run: Run, argv: string[]): boolean {
  if (argv.length !== 1) {
    run.reply('Please specify if you want chat text on or off.');
    return true;
  }
  const on = sameWord(argv[0], 'on');
  if (on || sameWord(argv[0], 'off')) {
    // The 1999 client.exe: UI_SetLocalChatSquelched @ 0x4d0470, client-only, prints its own line.
    const local = run.ctx.setLocalChatSquelched?.(!on);
    if (local !== undefined) {
      run.reply(local, CHAT_TYPE_DEFAULT);
      return true;
    }
    return modifyGlobalSquelch(run, on ? 0 : 1, 2);
  }
  run.reply('Please specify on or off.');
  return true;
}

/**
 * DoNoTell @ 0056fbd0 (decomp 357770–357800): @notell on squelches Tells (type 3).
 * Retail quirk: any word other than "off" counts as "on".
 */
function doNoTell(run: Run, argv: string[]): boolean {
  if (argv.length !== 1) {
    run.reply('Please specify if you want tells on or off.');
    return true;
  }
  let squelch = 1;
  if (!sameWord(argv[0], 'on') && sameWord(argv[0], 'off')) squelch = 0;
  return modifyGlobalSquelch(run, squelch, 3);
}

/** DoReply @ 00577910 (decomp 363110–363160): Event_TalkDirect to the last teller's guid. */
function doReply(run: Run, argv: string[]): boolean {
  const text = trimWs(joinArgs(argv));
  if (!text) {
    run.reply('You must specify the text you wish to say!');
  } else if (run.ctx.lastTeller() === 0) {
    run.reply('Someone must @tell you first!');
  } else {
    eventTalkDirect(run.ctx, text, run.ctx.lastTeller());
  }
  return true;
}

/**
 * DoReTell @ 00577bd0 (decomp 363270–363320): Event_TalkDirectByName to the last tellee.
 * Retail quirk: empty text returns silently (no message, unlike @reply / @say).
 */
function doReTell(run: Run, argv: string[]): boolean {
  const text = trimWs(joinArgs(argv));
  if (!text) return true;
  const name = run.ctx.lastTelleeName();
  if (name === '') {
    run.reply('You must first provide a name using @tell');
    return true;
  }
  talkDirectByName(run, text, name);
  return true;
}

/** DoSay @ 00581240 (decomp 371320–371350): PublicChat (inline poses, then Event_Talk). */
function doSay(run: Run, argv: string[]): boolean {
  const text = trimWs(joinArgs(argv));
  if (!text) run.reply('You must specify the text you wish to say!');
  else publicChat(run.ctx, text);
  return true;
}

/**
 * DoTell @ 00577e40 (decomp 363415–363460; disasm 0x577e40–0x577f55).
 * Retail quirks: the name is everything before the first comma, NOT trimmed
 * ("Bob ,hi" → "Bob "; ACE trims it); only the text is trimmed; there is no
 * empty-text check, so "@tell Bob," sends an empty tell.
 */
function doTell(run: Run, argv: string[]): boolean {
  const line = joinArgsAsName(argv);
  const idx = line.indexOf(',');
  if (idx < 1) {
    run.reply('Use comma after the name for targeted chat.');
    return true;
  }
  const name = line.slice(0, idx);
  const text = trimWs(line.slice(idx + 1));
  run.ctx.setLastTelleeName(name);
  talkDirectByName(run, text, name);
  return true;
}

/** HelpAFK(Detail_HelpType, "@afk") @ 00578060 — the text DoAFK prints for an unknown sub-command. */
export const HELP_AFK_DETAIL =
  '@afk - Turns on AFK (away-from-keyboard) mode. When set to AFK, other players that send you directed chatyou will receive a customizable message that your are not currently at the keyboard.\n'
  + '@afk on - Turns on AFK mode. When set to AFK, other players that send you directed chatyou will receive a customizable message that your are not currently at the keyboard.\n'
  + '@afk off - Turn off AFK mode.\n'
  + '@afk msg <message> - Set the message that will be sent to players that send you directed chat while you are in AFK mode. Issuing "@afk msg" with no message will set your AFK message back to the default. Your custom AFK message is limited to 192 characters.\n';

/**
 * DoAFK @ 0057b3f0 (decomp 366690–366830; disasm 0x57b692–0x57b839).
 * "on"/none → Event_SetAFKMode(1) unless already AFK; "off" → Event_SetAFKMode(0)
 * if AFK; "msg <text>" → trim spaces, cap at 192 chars, append "\n" if none,
 * Event_SetAFKMessage, echo with chat type 0; anything else → HelpAFK detail.
 */
function doAfk(run: Run, argv: string[]): boolean {
  const a = argv[0] ?? '';
  const rest = argv.slice(1);
  const ctx = run.ctx;
  if (a === '' || sameWord(a, 'on')) {
    if (!ctx.isAfk()) ctx.send(GameActionType.SetAfkMode, (w) => w.writeUInt32(1));
  } else if (sameWord(a, 'off')) {
    if (ctx.isAfk()) ctx.send(GameActionType.SetAfkMode, (w) => w.writeUInt32(0));
  } else if (sameWord(a, 'msg')) {
    let m = joinArgs(rest).replace(/^ +| +$/g, '');
    if (m !== '') {
      // len+1 > 0xc0 → substring(0, 0xbf) (inclusive end): at most 192 characters.
      if (m.length + 1 > 0xc0) m = m.slice(0, 0xc0);
      if (!m.includes('\n')) m += '\n';
    }
    ctx.send(GameActionType.SetAfkMessage, (w) => w.writeString16(m));
    if (m === '') run.reply('New AFK message set: I am currently away from the keyboard.', CHAT_TYPE_DEFAULT);
    else run.reply(`New AFK message set: ${m}`, CHAT_TYPE_DEFAULT);
  } else {
    run.reply(HELP_AFK_DETAIL, CHAT_TYPE_DEFAULT);
  }
  return true;
}

/**
 * DoStupidChannelHack @ 0057b130 (decomp 366500–366520) → DoChannelCommand @ 005774a0:
 * broadcast the joined words to the channel the typed command word names.
 */
function doStupidChannelHack(run: Run, argv: string[]): boolean {
  if (argv.length < 1) {
    run.reply('You must specify the text you wish to broadcast!');
    return true;
  }
  const id = getChannelId(run.command);
  if (id === 0 || id === CHANNEL_HELP) return false;
  return channelBroadcast(run.ctx, id, joinArgs(argv));
}

/** DoJoinChat @ 0056f510 / DoLeaveChat @ 0056f7f0 room words, in retail's compare order. */
const HEAR_ROOMS: ReadonlyArray<readonly [readonly string[], HearChatRoom]> = [
  [['Allegiance'], 'allegiance'],
  [['General'], 'general'],
  [['Trade'], 'trade'],
  [['LFG'], 'lfg'],
  [['Roleplay'], 'roleplay'],
  [['Society', 'Soc'], 'society'],
];

/**
 * DoJoinChat / DoLeaveChat (decomp 357480–357700): only the first word counts;
 * set the PlayerModule Hear*Chat option. No server send, no confirmation; an
 * unknown or missing room returns false ("That is not a valid command.").
 */
function setHearFromArg(run: Run, argv: string[], on: boolean): boolean {
  const a = argv[0] ?? '';
  for (const [words, room] of HEAR_ROOMS) {
    if (words.some((w) => sameWord(a, w))) {
      run.ctx.setHearChat(room, on);
      return true;
    }
  }
  return false;
}

/** DoJoinChat @ 0056f510. */
function doJoinChat(run: Run, argv: string[]): boolean { return setHearFromArg(run, argv, true); }
/** DoLeaveChat @ 0056f7f0. */
function doLeaveChat(run: Run, argv: string[]): boolean { return setHearFromArg(run, argv, false); }

/** DoChannelIndex @ 0056e640 (decomp 356610–356620): Event_ChannelIndex, arguments ignored. */
function doChannelIndex(run: Run): boolean {
  return run.ctx.send(GameActionType.IndexChannels);
}

/**
 * DoChannelList @ 0057a9b0 / DoChannelOn @ 0057aa80 / DoChannelOff @ 0057ab50
 * (decomp 366080–366195): one channel alias (Help accepted here) → Event with its id.
 */
function channelCommand(type: GameActionType) {
  return (run: Run, argv: string[]): boolean => {
    if (argv.length !== 1) {
      run.reply('Please specify the channel name.');
      return true;
    }
    const id = getChannelId(argv[0]);
    if (id === 0) {
      // HandleFailureEvent(0x422): type 0x1a, window 0.
      run.ctx.print(CHANNEL_DOES_NOT_EXIST, CHAT_TYPE_COMMAND, ALL_WINDOWS);
      return true;
    }
    return run.ctx.send(type, (w) => w.writeUInt32(id >>> 0));
  };
}
const doChannelList = channelCommand(GameActionType.ListChannels);
const doChannelOn = channelCommand(GameActionType.AddChannel);
const doChannelOff = channelCommand(GameActionType.RemoveChannel);

// ── Turbine chat rooms (DoTurbineChat_* @ 0057eba0..0057ef20, decomp 369513–369760) ──

/** HandleFailureEvent(0x414) (hfe 0x414): type 0x1a, window 0. */
export const NOT_IN_AN_ALLEGIANCE = 'You are not in an allegiance!';

/**
 * One DoTurbineChat_* handler. Retail quirks kept: no words → HandleFailureEvent(0x26)
 * then return false, so "That is not a valid command." prints twice; only the
 * Allegiance handler checks for a zero room (failure 0x414, again followed by the
 * dispatcher's line); the others leave a zero room to SendTurbineChat ("Turbine
 * chat is not available."), whose false also adds "That is not a valid command.".
 */
function turbineChat(room: TurbineRoom, chatType: TurbineChatType, hears: (ctx: ChatCommandContext) => boolean, checkRoom: boolean) {
  return (run: Run, argv: string[]): boolean => {
    const ctx = run.ctx;
    if (argv.length === 0) {
      ctx.print(NOT_A_VALID_COMMAND, CHAT_TYPE_COMMAND, ALL_WINDOWS);
      return false;
    }
    const roomId = ctx.turbineRoom(room);
    if (checkRoom && roomId === 0) {
      ctx.print(NOT_IN_AN_ALLEGIANCE, CHAT_TYPE_COMMAND, ALL_WINDOWS);
      return false;
    }
    return sendTurbineChat(ctx, run.spam, roomId, chatType, joinArgs(argv), hears(ctx));
  };
}

/** DoTurbineChat_Allegiance @ 0057eba0: room tracker+0x04, HearAllegianceChat. */
const doTurbineChatAllegiance = turbineChat('allegiance', TurbineChatType.Allegiance, (c) => c.hearsAllegianceChat(), true);
/** DoTurbineChat_General @ 0057ec50: HearGeneralChat. */
const doTurbineChatGeneral = turbineChat('general', TurbineChatType.General, (c) => c.hearsChat('general'), false);
/** DoTurbineChat_Trade @ 0057ece0: HearTradeChat. */
const doTurbineChatTrade = turbineChat('trade', TurbineChatType.Trade, (c) => c.hearsChat('trade'), false);
/** DoTurbineChat_LFG @ 0057ed70: HearLFGChat. */
const doTurbineChatLfg = turbineChat('lfg', TurbineChatType.LFG, (c) => c.hearsChat('lfg'), false);
/** DoTurbineChat_Roleplay @ 0057ee00: HearRoleplayChat. */
const doTurbineChatRoleplay = turbineChat('roleplay', TurbineChatType.Roleplay, (c) => c.hearsChat('roleplay'), false);
/** DoTurbineChat_Olthoi @ 0057ee90: gated on CPlayerSystem::IsOlthoi. */
const doTurbineChatOlthoi = turbineChat('olthoi', TurbineChatType.Olthoi, (c) => c.isOlthoi(), false);
/** DoTurbineChat_Society @ 0057ef20: HearSocietyChat. */
const doTurbineChatSociety = turbineChat('society', TurbineChatType.Society, (c) => c.hearsChat('society'), false);

// ── tables ──

const STUPID_CHANNEL_HACK_NAMES = [
  'a', 'co-vassals', 'covassals', 'covassal', 'c', 'fellowship', 'fellows', 'fellow', 'f', 'group', 'g', 'party',
  'monarch', 'm', 'patron', 'p', 'vassals', 'vassal', 'v',
];

/** The chat group's InitializeCommands @ 00581970 entries. */
export function chatCommandEntries(): CommandEntry<ChatCommandContext>[] {
  const e = (name: string, handler: CommandEntry<ChatCommandContext>['handler'], help: string | null) => ({ name, handler, help });
  return [
    e('channels', null, 'HelpChannelsGroup'),
    ...STUPID_CHANNEL_HACK_NAMES.map((n) => e(n, doStupidChannelHack, 'HelpStupidChannelHack')),
    e('join', doJoinChat, 'HelpJoinChat'),
    e('leave', doLeaveChat, 'HelpLeaveChat'),
    e('chatting', null, 'HelpChattingGroup'),
    e('chat', doChatToggle, 'HelpChatToggle'),
    e('notell', doNoTell, 'HelpNoTell'),
    e('reply', doReply, 'HelpReply'),
    e('r', doReply, 'HelpReply'),
    e('rp', doReply, 'HelpReply'),
    e('mr', null, 'HelpReply'),
    e('pr', null, 'HelpReply'),
    e('retell', doReTell, 'HelpReTell'),
    e('rt', doReTell, 'HelpReTell'),
    e('say', doSay, 'HelpSay'),
    e('s', doSay, 'HelpSay'),
    e('tell', doTell, 'HelpTell'),
    e('t', doTell, 'HelpTell'),
    e('send', doTell, 'HelpTell'),
    e('whisper', doTell, 'HelpTell'),
    e('w', doTell, 'HelpTell'),
    e('afk', doAfk, 'HelpAFK'),
    e('index', doChannelIndex, null),
    e('clist', doChannelList, null),
    e('on', doChannelOn, null),
    e('off', doChannelOff, null),
  ];
}

/**
 * StartupTurbineChatSystem @ 0057efb0 (decomp ~369765–370260): registered only once
 * Turbine chat starts, and `a` REPLACES the DoStupidChannelHack `a` — register these
 * with `system.register(entry, true)`.
 */
export function turbineChatCommandEntries(): CommandEntry<ChatCommandContext>[] {
  const t = (names: string[], handler: CommandEntry<ChatCommandContext>['handler'], help: string) =>
    names.map((name) => ({ name, handler, help }));
  return [
    ...t(['a', 'guild', 'gu'], doTurbineChatAllegiance, 'HelpTurbineChat_Allegiance'),
    ...t(['general', 'cg'], doTurbineChatGeneral, 'HelpTurbineChat_General'),
    ...t(['trade', 'ct'], doTurbineChatTrade, 'HelpTurbineChat_Trade'),
    ...t(['lfg', 'clfg'], doTurbineChatLfg, 'HelpTurbineChat_LFG'),
    ...t(['roleplay', 'crp'], doTurbineChatRoleplay, 'HelpTurbineChat_Roleplay'),
    ...t(['society', 'soc'], doTurbineChatSociety, 'HelpTurbineChat_Society'),
    ...t(['olthoi', 'o'], doTurbineChatOlthoi, 'HelpTurbineChat_Olthoi'),
  ];
}
