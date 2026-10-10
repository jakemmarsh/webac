/**
 * The retail chat-command system, ported from the decompiled EoL client's
 * ClientCommunicationSystem (reference/client-eol). Every line typed into
 * any chat entry (the main chat, its Send button, a floating chat window)
 * goes through {@link onChatCommand}, as retail's did:
 *
 *  - OnChatCommand @ 00581320: a leading '/' becomes '@' and the line is a
 *    command (DoCommand); ':' or ';' becomes "@emote <rest>"; anything else
 *    is talk — PublicChat, or the main chat's talk focus.
 *  - DoCommand @ 0057e2e0: the first word (minus '@', trailing ',' trimmed)
 *    is looked up case-insensitively in the command table
 *    (InitializeCommands @ 00581970 + StartupTurbineChatSystem @ 0057efb0).
 *    A handler that returns false prints "That is not a valid command."
 *    (HandleFailureEvent 0x26). A name with no handler goes to
 *    DoChannelCommand @ 005774a0 (the ChannelSystem::GetChannelID aliases),
 *    and failing that the WHOLE line goes to the server as Event_Talk —
 *    which is how ACE's own '@' commands are reached.
 *
 * Handlers live in the sibling handler modules, one per retail group; each
 * reads only the context slice it declares. The full specification (every
 * handler, string and message type, with decomp line numbers) is
 * docs/retail-commands/.
 */
import { GameActionType, type BinaryWriter } from '@ac/network';

/** AddTextToScroll chat types the command system prints with. */
export const CHAT_TYPE_DEFAULT = 0;
/** Retail's command-feedback / validation type (0x1a; ACE leaves it unnamed). */
export const CHAT_TYPE_COMMAND = 0x1a;
/** Emote lines (HearEmote / the local soul-emote echo). */
export const CHAT_TYPE_EMOTE = 0xc;

/** AddTextToScroll's window 0: every window, filtered per window. */
export const ALL_WINDOWS = 0;

/** Retail command sources that use the talk focus (the main chat entry). */
export const TALK_FOCUS_SOURCES: readonly number[] = [1, 8];

/** gmCCommunicationSystem talk focus values (globals.tsv *_TalkFocus). */
export const enum TalkFocus {
  All = 1, Selected = 2, Fellows = 3, Patron = 4, Monarch = 5, Vassals = 6,
  Allegiance = 7, General = 8, Trade = 9, LFG = 10, Roleplay = 11, Society = 12, Olthoi = 13,
}

/** Turbine chat types (ChatTypeEnum) SendTurbineChat is called with. */
export const enum TurbineChatType {
  Allegiance = 1, General = 2, Trade = 3, LFG = 4, Roleplay = 5, Society = 6, Olthoi = 10,
}

/** Chat rooms the ChatRoomTracker holds (Handle_Communication__Recv_ChatRoomTracker). */
export type TurbineRoom = 'allegiance' | 'general' | 'trade' | 'lfg' | 'roleplay' | 'society' | 'olthoi';

/** A ChatPoseTable (0x0E000007) hit: InqChatPoseCommand @ 00570ad0. */
export interface ChatPose {
  /** The canonical pose command (the motion command name for string2command). */
  command: string;
  myEmote: string;
  otherEmote: string;
}

/** What the dispatcher itself needs from the client. */
export interface CoreCommandContext {
  /**
   * ClientSystem::AddTextToScroll(text, chatType, true, windowId). Text is
   * retail's, newlines included (a trailing "\n" ends the line).
   */
  print(text: string, chatType: number, windowId: number): void;
  /** Proto_UI::SendToWeenie: one GameAction; false when it could not be sent. */
  send(type: GameActionType, write?: (w: BinaryWriter) => void): boolean;
  /** gmCCommunicationSystem::GetTalkFocus (1 when there is none). */
  talkFocus(): number;
  /** gmCCommunicationSystem::GetLastSpeakableTarget (0 = none). */
  lastSpeakableTarget(): number;
  /** CCommunicationSystem::IsUsingTurbineChat. */
  usingTurbineChat(): boolean;
  /** ChatRoomTracker room id (0 = none). */
  turbineRoom(room: TurbineRoom): number;
  /** CSendToTurbineRoomByID; false when it failed. */
  sendTurbineChat(roomId: number, chatType: number, text: string): boolean;
  /** PlayerModule hear-chat options. */
  hearsAllegianceChat(): boolean;
  /** CPlayerSystem::IsOlthoi. */
  isOlthoi(): boolean;
  /** ChannelSystem::GetGlobalChannelName for a Turbine chat type. */
  globalChannelName(chatType: number): string;
  /** InqChatPoseCommand: the ChatPoseTable entry for a pose name (case-insensitive), or null. */
  chatPose(name: string): ChatPose | null;
  /** string2command + the command interpreter: start the motion; false when the name is no motion command. */
  playPoseMotion(command: string): boolean;
  /** PlayerDesc PropertyInt 0x71 (Gender), 1 when unknown. */
  gender(): number;
  /** Seconds, for IsMessageSpam. */
  nowSeconds(): number;
}

/** One DoCommand invocation. */
export interface CommandRun<C> {
  readonly ctx: C;
  /** m_idCurrentCommandSource: the window the line was typed in. */
  readonly source: number;
  /** m_strCurrentCommand: the command word, '@' stripped, trailing ',' trimmed. */
  readonly command: string;
  /** m_strLastCommandLine: the whole (trimmed) line, with the '@'. */
  readonly line: string;
  /** Print to the command's window (AddTextToScroll(…, m_idCurrentCommandSource)). */
  reply(text: string, chatType?: number): void;
  /** Re-enter OnChatCommand from this source (DoLoadFile). */
  dispatch(line: string): void;
  /** The command table (DoHelp looks entries up by name). */
  lookup(name: string): CommandEntry<C> | undefined;
  /** Every entry in the table (help group listings). */
  entries(): CommandEntry<C>[];
  /** The Turbine-chat spam meter (IsMessageSpam) shared by every SendTurbineChat. */
  readonly spam: SpamMeter;
}

/** A retail command handler: bool DoX(int argc, char **argv). False → "That is not a valid command.". */
export type CommandHandler<C> = (run: CommandRun<C>, argv: string[]) => boolean;

/** A command-table entry (ClientCommunicationSystem::CmdHashData). */
export interface CommandEntry<C> {
  name: string;
  /** null for help-only group entries (they fall through to DoChannelCommand / Talk). */
  handler: CommandHandler<C> | null;
  /** The retail Help* function name (e.g. 'HelpDie'), the key into the help texts; null = "Unknown command" under @help. */
  help: string | null;
}

/** HandleFailureEvent(0x26) @ 360012: window 0, type 0x1a. */
export const NOT_A_VALID_COMMAND = 'That is not a valid command.';
/** HandleFailureEvent(0x422). */
export const CHANNEL_DOES_NOT_EXIST = "That channel doesn't exist.";

// ── argument helpers (DoCommand's FindAllWords split on " \t") ──

/** PSUtils::FindAllWords(line, " \t"). */
export function findAllWords(line: string): string[] {
  return line.split(/[ \t]+/).filter((w) => w.length > 0);
}

/** JoinArgs @ 00575ac0: argv joined with single spaces. */
export function joinArgs(argv: readonly string[]): string {
  return argv.join(' ');
}

/** JoinArgsAsName @ 00575c10: JoinArgs, whitespace trimmed, leading '+' stripped. */
export function joinArgsAsName(argv: readonly string[]): string {
  return joinArgs(argv).trim().replace(/^\++/, '');
}

/** _stricmp(a, b) == 0. */
export function sameWord(a: string | undefined, b: string): boolean {
  return a !== undefined && a.toLowerCase() === b.toLowerCase();
}

// ── ChannelSystem::GetChannelID @ 005cf1f0 ──

const CHANNEL_ALIASES: ReadonlyArray<readonly [readonly string[], number]> = [
  [['allegiance', 'a', 'ab'], 0x02000000],
  [['co-vassals', 'covassals', 'covassal', 'c'], 0x01000000],
  [['monarch', 'm'], 0x00004000],
  [['patron', 'p'], 0x00002000],
  [['vassals', 'vassal', 'v'], 0x00001000],
  [['fellowship', 'fellows', 'fellow', 'f', 'group', 'g', 'party'], 0x00000800],
  [['av', 'av1', 'advocate', 'advocate1'], 0x00000008],
  [['av2', 'advocate2'], 0x00000010],
  [['av3', 'advocate3'], 0x00000020],
  [['abuse'], 0x00000001],
  [['ad', 'admin'], 0x00000002],
  [['au', 'audit'], 0x00000004],
  [['help'], 0x00000400],
  [['sent', 'sentinel'], 0x00000200],
  [['celestialhand', 'celhan'], 0x08000000],
  [['eldrytchweb', 'eldweb'], 0x10000000],
  [['radiantblood', 'radblo'], 0x20000000],
  [['olthoi', 'ol'], 0x40000000],
];

/** The Help channel: never broadcast by DoChannelCommand. */
export const CHANNEL_HELP = 0x400;

/** ChannelSystem::GetChannelID: the channel bit for an alias (case-insensitive), 0 for none. */
export function getChannelId(name: string): number {
  if (!name) return 0;
  const n = name.toLowerCase();
  for (const [aliases, id] of CHANNEL_ALIASES) if (aliases.includes(n)) return id;
  return 0;
}

/** Event_ChannelBroadcast (0x147): channel u32, text String16L. */
export function channelBroadcast(ctx: CoreCommandContext, channel: number, text: string): boolean {
  return ctx.send(GameActionType.ChatChannel, (w) => { w.writeUInt32(channel >>> 0); w.writeString16(text); });
}

/** Event_Talk (0x15). */
export function eventTalk(ctx: CoreCommandContext, text: string): boolean {
  return ctx.send(GameActionType.Talk, (w) => w.writeString16(text));
}

/** Event_TalkDirect (0x32): text, target guid. */
export function eventTalkDirect(ctx: CoreCommandContext, text: string, guid: number): boolean {
  return ctx.send(GameActionType.TalkDirect, (w) => { w.writeString16(text); w.writeUInt32(guid >>> 0); });
}

// ── PublicChat @ 005810f0 and Pose @ 00580480 ──

/**
 * ClientCommunicationSystem::Pose: look the name up in the ChatPoseTable,
 * start its motion, send the others' text (with %p → his/her) as a
 * SoulEmote, and echo "You <myEmote>" locally (type 0xc, window 0).
 * Returns whether a motion command was found (only then is the span cut).
 */
export function pose(ctx: CoreCommandContext, name: string): boolean {
  const entry = ctx.chatPose(name);
  if (!entry) return false;
  const moved = ctx.playPoseMotion(entry.command);
  if (entry.otherEmote) {
    const pronoun = ctx.gender() !== 1 ? 'her' : 'his';
    const others = entry.otherEmote.split('%p').join(pronoun);
    ctx.send(GameActionType.SoulEmote, (w) => w.writeString16(others));
  }
  // Handle_Communication__HearSoulEmote(0, "You", myEmote) → HearEmote: "You " + text + "\n", type 0xc.
  if (entry.myEmote) ctx.print(`You${entry.myEmote.startsWith("'") ? '' : ' '}${entry.myEmote}\n`, CHAT_TYPE_EMOTE, ALL_WINDOWS);
  return moved;
}

/**
 * RemoveTextBetween @ 00580fd0 over the whole line: each open…close span
 * whose inner text is a pose (Pose returns true) is performed and cut out,
 * delimiters included; any other span stays in the spoken text.
 */
function removePoses(ctx: CoreCommandContext, text: string, open: string, close: string): string {
  let out = text;
  let from = 0;
  for (;;) {
    const a = out.indexOf(open, from);
    if (a < 0) return out;
    const b = out.indexOf(close, a + 1);
    if (b < 0) return out;
    if (pose(ctx, out.slice(a + 1, b))) {
      out = out.slice(0, a) + out.slice(b + 1);
      from = a;
    } else {
      from = b + 1;
    }
  }
}

/** PublicChat @ 005810f0: perform inline *pose* / <pose> spans, then Event_Talk what is left. */
export function publicChat(ctx: CoreCommandContext, text: string): void {
  let rest = removePoses(ctx, text, '*', '*');
  rest = removePoses(ctx, rest, '<', '>');
  rest = rest.trim();
  if (rest) eventTalk(ctx, rest);
}

// ── SendTurbineChat @ 0057db10 ──

/** IsMessageSafe @ 0056ed70: no "<tell:" (any case) and no newline. */
export function isMessageSafe(text: string): boolean {
  return !text.toLowerCase().includes('<tell:') && !text.includes('\n');
}

/** IsMessageSpam @ 0056e580: count += 1 − elapsed seconds (floored at 0); spam while count > 0. */
export class SpamMeter {
  private count = 0;
  private last = Number.NaN;
  isSpam(now: number): boolean {
    if (Number.isNaN(this.last)) this.last = now;
    this.count = Math.max(0, this.count - (now - this.last));
    this.last = now;
    const spam = this.count > 0;
    this.count += 1;
    return spam;
  }
}

/**
 * SendTurbineChat(room, chatType, text, allowed). Retail's own strings and
 * order: unavailable → "Turbine chat is not available.", not listening →
 * failure 0x551, empty/unsafe → silent false, spam → "You must wait 0s…"
 * (the %d is a literal 0), failed send → "Failed to send text to channel: %s".
 */
export function sendTurbineChat(ctx: CoreCommandContext, spam: SpamMeter, roomId: number, chatType: number, text: string, allowed: boolean): boolean {
  if (!ctx.usingTurbineChat() || roomId === 0) {
    ctx.print('Turbine chat is not available.\n', CHAT_TYPE_DEFAULT, ALL_WINDOWS);
    return false;
  }
  if (!allowed) {
    ctx.print(`You are not listening to the ${ctx.globalChannelName(chatType)} channel!\n`, CHAT_TYPE_DEFAULT, ALL_WINDOWS);
    return true;
  }
  if (!text || !isMessageSafe(text)) return false;
  if (spam.isSpam(ctx.nowSeconds())) {
    ctx.print('You must wait 0s before communicating again!', CHAT_TYPE_DEFAULT, ALL_WINDOWS);
    return false;
  }
  if (!ctx.sendTurbineChat(roomId, chatType, text)) {
    ctx.print(`Failed to send text to channel: ${ctx.globalChannelName(chatType)}\n`, CHAT_TYPE_DEFAULT, ALL_WINDOWS);
    return false;
  }
  return true;
}

// ── the command system ──

export class CommandSystem<C extends CoreCommandContext> {
  private readonly table = new Map<string, CommandEntry<C>>();
  readonly spam = new SpamMeter();

  constructor(readonly ctx: C, entries: Iterable<CommandEntry<C>>) {
    for (const e of entries) this.register(e);
  }

  /** IntrusiveHashTable::add — the first registration of a name wins, except where retail re-registers (StartupTurbineChatSystem). */
  register(entry: CommandEntry<C>, replace = false): void {
    const key = entry.name.toLowerCase();
    if (!replace && this.table.has(key)) return;
    this.table.set(key, entry);
  }

  /** The entry for a name (case-insensitive). */
  lookup(name: string): CommandEntry<C> | undefined {
    return this.table.get(name.toLowerCase());
  }

  /** Every registered entry. */
  entries(): CommandEntry<C>[] {
    return [...this.table.values()];
  }

  /** OnChatCommand @ 00581320. */
  onChatCommand(text: string, source: number): void {
    const line = text.trim();
    switch (line.charAt(0)) {
      case '/':
        this.doCommand('@' + line.slice(1), source);
        return;
      case '@':
        this.doCommand(line, source);
        return;
      case ':':
      case ';':
        this.doCommand('@emote' + ' ' + line.slice(1), source);
        return;
    }
    if (!TALK_FOCUS_SOURCES.includes(source)) {
      publicChat(this.ctx, line);
      return;
    }
    this.talkByFocus(line);
  }

  /** OnChatCommand's talk-focus switch (decoded from the jump table at 0x5816d4). */
  private talkByFocus(line: string): void {
    const ctx = this.ctx;
    const turbine = (room: TurbineRoom, chatType: number, allowed: boolean) =>
      sendTurbineChat(ctx, this.spam, ctx.turbineRoom(room), chatType, line, allowed);
    switch (ctx.talkFocus()) {
      case TalkFocus.All: publicChat(ctx, line); return;
      case TalkFocus.Selected: {
        const target = ctx.lastSpeakableTarget();
        if (target !== 0) eventTalkDirect(ctx, line, target);
        return;
      }
      case TalkFocus.Fellows: channelBroadcast(ctx, 0x800, line); return;
      case TalkFocus.Patron: channelBroadcast(ctx, 0x2000, line); return;
      case TalkFocus.Monarch: channelBroadcast(ctx, 0x4000, line); return;
      case TalkFocus.Vassals: channelBroadcast(ctx, 0x1000, line); return;
      // Retail passes ChatType 1 and gates on HearAllegianceChat for foci 7–12 (one shared tail @ 0x581686).
      case TalkFocus.Allegiance: turbine('allegiance', TurbineChatType.Allegiance, ctx.hearsAllegianceChat()); return;
      case TalkFocus.General: turbine('general', TurbineChatType.Allegiance, ctx.hearsAllegianceChat()); return;
      case TalkFocus.Trade: turbine('trade', TurbineChatType.Allegiance, ctx.hearsAllegianceChat()); return;
      case TalkFocus.LFG: turbine('lfg', TurbineChatType.Allegiance, ctx.hearsAllegianceChat()); return;
      case TalkFocus.Roleplay: turbine('roleplay', TurbineChatType.Allegiance, ctx.hearsAllegianceChat()); return;
      case TalkFocus.Society: turbine('society', TurbineChatType.Allegiance, ctx.hearsAllegianceChat()); return;
      case TalkFocus.Olthoi: turbine('olthoi', TurbineChatType.Olthoi, ctx.isOlthoi()); return;
      default: return;
    }
  }

  /** DoCommand @ 0057e2e0. `line` starts with '@'. */
  doCommand(line: string, source: number): boolean {
    const words = findAllWords(line);
    if (words.length === 0) return false;
    const command = words[0].slice(1).replace(/,+$/, '');
    const argv = words.slice(1);
    const run: CommandRun<C> = {
      ctx: this.ctx,
      source,
      command,
      line,
      reply: (text, chatType = CHAT_TYPE_COMMAND) => this.ctx.print(text, chatType, source),
      dispatch: (next) => this.onChatCommand(next, source),
      lookup: (name) => this.lookup(name),
      entries: () => this.entries(),
      spam: this.spam,
    };
    const entry = this.lookup(command);
    if (!entry || !entry.handler) {
      if (!this.doChannelCommand(command, argv)) eventTalk(this.ctx, line);
      return true;
    }
    if (!entry.handler(run, argv)) this.ctx.print(NOT_A_VALID_COMMAND, CHAT_TYPE_COMMAND, ALL_WINDOWS);
    return true;
  }

  /** DoChannelCommand @ 005774a0: broadcast to a channel alias (not Help) when there is text. */
  doChannelCommand(command: string, argv: readonly string[]): boolean {
    if (argv.length < 1) return false;
    const id = getChannelId(command);
    if (id === 0 || id === CHANNEL_HELP) return false;
    return channelBroadcast(this.ctx, id, joinArgs(argv));
  }
}
