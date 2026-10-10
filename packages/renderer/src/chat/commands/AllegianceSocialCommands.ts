/**
 * Retail allegiance and social chat commands, ported from the decompiled
 * EoL client's ClientCommunicationSystem (reference/client-eol, line numbers
 * are in acclient-decompiled.annotated.c): @allegiance / @all and their 15
 * subcommand words, @ab, @alh / @ah, @motd, @speaker, @friends (+ the
 * gmFriendsUI receivers that hold the friends logic), @friends_add,
 * @friends_remove, @squelch, @unsquelch and @title.
 *
 * Specification (every string, chat type and opcode):
 * docs/retail-commands/allegiance-social.md.
 */
import { GameActionType } from '@ac/network';
import {
  ALL_WINDOWS,
  CHAT_TYPE_COMMAND,
  CHAT_TYPE_DEFAULT,
  TALK_FOCUS_SOURCES,
  channelBroadcast,
  joinArgs,
  joinArgsAsName,
  sameWord,
  type CommandEntry,
  type CommandRun,
  type CoreCommandContext,
} from './CommandSystem';

/** One gmFriendsUI friends-list entry (FriendData). */
export interface FriendEntry {
  /** FriendData::m_id: the friend's character guid. */
  id: number;
  /** FriendData::m_name, as stored (may carry a leading '+'). */
  name: string;
  /** The listbox name text's state is 0x10000054 (online). */
  online: boolean;
}

/** What the allegiance / social handlers need beyond the core. */
export interface AllegianceSocialCommandContext extends CoreCommandContext {
  /** PlayerModule::SetHearAllegianceChat: set CharacterOptions1 0x40000000 (HearAllegianceChat) and persist the option. */
  setHearAllegianceChat(on: boolean): void;
  /** gmFriendsUI's friends list, in friends-panel (sorted listbox) order. */
  friends(): FriendEntry[];
  /** gmFriendsUI::RecvNotice_ChatCommand_RemoveAllFriends: clear the local friends list + listbox and deselect. */
  clearFriends(): void;
  /** ECM_UI::SendNotice_DisplayWeenieError(code): show the client's weenie-error text for `code` (0x561 / 0x563 here). */
  weenieError(code: number): void;
  /** Proto_UI::SendFriendsCommand(0, ""): control message 0xF7CD (FriendsOld) with u32 0 + empty string; false when not sent. */
  sendFriendsOld(): boolean;
  /** gmCCommunicationSystem::GetLastTellerName ("" when nobody has told you). */
  lastTellerName(): string;
  /**
   * gmCCommunicationSystem's squelch database for DoSquelchQuery: one
   * ConvertSQToPString(entry, 0) text per squelched character/account,
   * in hash order; null when there is no CCommunicationSystem.
   */
  squelchEntries(): string[] | null;
  /** CM_UI::SendNotice_SetChatWindowTitle(windowId, title): retitle that popup (floaty) chat window. */
  setChatWindowTitle(windowId: number, title: string): void;
  /**
   * Set only on a 1999 world (era ac1999-retail): there the server holds the
   * friends list and answers @friends in chat (KB 0xF7CD FriendsCommand), and
   * there is no friends panel. Receives the subcommand ('', add, remove,
   * online…) and the joined name; the 1999 adapter sends the command.
   */
  serverFriends1999?: (sub: string, name: string) => void;
}

type Run = CommandRun<AllegianceSocialCommandContext>;

/** NextArg @ 0056ee90: pop one word ("" and nothing popped when empty). */
function nextArg(argv: string[]): string {
  return argv.length === 0 ? '' : (argv.shift() as string);
}

/** strtol(s, NULL, 0): leading whitespace, sign, 0x hex / 0 octal / decimal prefix; 0 when no digits. */
export function strtol0(s: string): number {
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)?/.exec(s);
  if (!m || m[2] === undefined) return 0;
  const body = m[2];
  let v: number;
  if (/^0[xX]/.test(body)) v = parseInt(body.slice(2), 16);
  else if (body.length > 1 && body[0] === '0') v = parseInt(body, 8);
  else v = parseInt(body, 10);
  return m[1] === '-' ? -v : v;
}

const PLEASE_SPECIFY_NAME = 'Please specify an actual name.';
const PLEASE_SPECIFY_MEMBER = 'Please specify the name of an allegiance member.';
const ALLEGIANCE_USAGE = 'Please see @help Allegiance for more information on how to use this command.';

// ── DoAllegiance and its sub-handlers ──

/**
 * DoAllegiance @ 0057d5a0 (368496-368653). One NextArg picks the
 * subcommand (case-insensitive, exact word); the sub-handler gets the
 * remaining words. A miss, a false sub-handler or a failed hometown send
 * prints the usage line (0x1a). Always returns true.
 */
function doAllegiance(run: Run, argv: string[]): boolean {
  const rest = argv.slice();
  const sub = nextArg(rest);
  let ok = false;
  if (sameWord(sub, 'boot')) ok = doAllegianceBoot(run, rest);
  else if (sameWord(sub, 'info')) ok = doAllegianceInfo(run, rest);
  else if (sameWord(sub, 'chat') || sameWord(sub, 'ch')) ok = doAllegianceChat(run, rest);
  else if (sameWord(sub, 'broadcast') || sameWord(sub, 'br')) ok = doAllegianceBroadcast(run, rest);
  else if (sameWord(sub, 'ban')) ok = doAllegianceBan(run, rest);
  else if (sameWord(sub, 'officer')) ok = doAllegianceOfficer(run, rest);
  else if (sameWord(sub, 'title')) ok = doAllegianceOfficerTitle(run, rest);
  // Retail quirk: no argument check here, unlike @ah / @alh.
  else if (sameWord(sub, 'hometown') || sameWord(sub, 'ho')) ok = run.ctx.send(GameActionType.RecallAllegianceHometown);
  else if (sameWord(sub, 'motd')) ok = doMotd(run, rest);
  else if (sameWord(sub, 'name')) ok = doAllegianceName(run, rest);
  else if (sameWord(sub, 'lock')) ok = doAllegianceLock(run, rest);
  else if (sameWord(sub, 'house')) ok = doAllegianceHouse(run, rest);
  if (!ok) run.reply(ALLEGIANCE_USAGE, CHAT_TYPE_COMMAND);
  return true;
}

/**
 * DoAllegianceBoot @ 0057aef0 (366398-366475). "-account" (case-sensitive
 * FindSubString) is cut together with the one character after it, then the
 * name is trimmed. Retail quirk: the empty check runs BEFORE the cut, so
 * "@allegiance boot -account" sends an empty name.
 */
function doAllegianceBoot(run: Run, argv: string[]): boolean {
  let name = joinArgsAsName(argv);
  if (name === '') {
    run.reply(PLEASE_SPECIFY_NAME, CHAT_TYPE_COMMAND);
    return true;
  }
  let account = false;
  const at = name.indexOf('-account');
  if (at >= 0) {
    account = true;
    name = name.slice(0, at) + name.slice(Math.min(name.length, at + '-account'.length + 1));
  }
  name = name.trim();
  run.reply(`Attempting to boot ${name}${account ? ' (Account)' : ''}...\n`, CHAT_TYPE_DEFAULT);
  return run.ctx.send(GameActionType.BreakAllegianceBoot, (w) => { w.writeString16(name); w.writeUInt32(account ? 1 : 0); });
}

/** DoAllegianceInfo @ 00576560 (362014-362050). */
function doAllegianceInfo(run: Run, argv: string[]): boolean {
  const name = joinArgsAsName(argv);
  if (name === '') {
    run.reply(PLEASE_SPECIFY_NAME, CHAT_TYPE_COMMAND);
    return true;
  }
  return run.ctx.send(GameActionType.AllegianceInfoRequest, (w) => w.writeString16(name));
}

/**
 * DoAllegianceChat @ 00575cb0 (361634-361855): on / off / kick / gag /
 * ungag; anything else (or nothing) → false (usage line).
 */
function doAllegianceChat(run: Run, argv: string[]): boolean {
  const rest = argv.slice();
  const sub = nextArg(rest);
  const ctx = run.ctx;
  if (sameWord(sub, 'on') || sameWord(sub, 'off')) {
    const on = sameWord(sub, 'on');
    // SetHearAllegianceChat @ 005d3570: nothing happens when the bit already matches.
    if (ctx.hearsAllegianceChat() !== on) ctx.setHearAllegianceChat(on);
    return true;
  }
  if (sameWord(sub, 'kick')) {
    // Retail quirk: JoinArgs (no trim, no empty check); the name before the comma is not trimmed.
    let name = joinArgs(rest);
    let reason = 'No reason given.';
    const comma = name.indexOf(',');
    if (comma >= 0) {
      reason = name.slice(comma + 1).trim();
      name = name.slice(0, comma);
    }
    ctx.send(GameActionType.AllegianceChatBoot, (w) => { w.writeString16(name); w.writeString16(reason); });
    return true;
  }
  if (sameWord(sub, 'gag') || sameWord(sub, 'ungag')) {
    // Retail quirk: JoinArgs, not JoinArgsAsName (no '+' strip).
    const name = joinArgs(rest);
    if (name === '') {
      run.reply(PLEASE_SPECIFY_NAME, CHAT_TYPE_COMMAND);
      return true;
    }
    const enabled = sameWord(sub, 'gag') ? 1 : 0;
    ctx.send(GameActionType.AllegianceChatGag, (w) => { w.writeString16(name); w.writeUInt32(enabled); });
    return true;
  }
  return false;
}

/**
 * DoAllegianceBroadcast @ 005761f0 (361858-361880): ChannelBroadcast to
 * 0x02000000 (AllegianceBroadcast). Empty text → false with no message of
 * its own. No local echo.
 */
function doAllegianceBroadcast(run: Run, argv: string[]): boolean {
  const text = joinArgs(argv);
  if (text === '') return false;
  return channelBroadcast(run.ctx, 0x02000000, text);
}

/**
 * DoAllegianceBan @ 005762a0 (361896-361998). Retail quirk: the empty-name
 * check runs before the subcommand is validated.
 */
function doAllegianceBan(run: Run, argv: string[]): boolean {
  const rest = argv.slice();
  const sub = nextArg(rest);
  if (sameWord(sub, 'list')) return run.ctx.send(GameActionType.ListAllegianceBans);
  const name = joinArgsAsName(rest);
  if (name === '') {
    run.reply(PLEASE_SPECIFY_NAME, CHAT_TYPE_COMMAND);
    return true;
  }
  if (sameWord(sub, 'add')) return run.ctx.send(GameActionType.AddAllegianceBan, (w) => w.writeString16(name));
  if (sameWord(sub, 'remove')) return run.ctx.send(GameActionType.RemoveAllegianceBan, (w) => w.writeString16(name));
  return false;
}

/** DoAllegianceOfficer @ 00576650 (362060-362215). */
function doAllegianceOfficer(run: Run, argv: string[]): boolean {
  const ctx = run.ctx;
  if (argv.length === 0) return ctx.send(GameActionType.ListAllegianceOfficers);
  const rest = argv.slice();
  const sub = nextArg(rest);
  if (sameWord(sub, 'list')) return ctx.send(GameActionType.ListAllegianceOfficers);
  if (sameWord(sub, 'clear')) return ctx.send(GameActionType.ClearAllegianceOfficers);
  if (sameWord(sub, 'remove')) {
    const name = joinArgsAsName(rest);
    if (name === '') {
      run.reply(PLEASE_SPECIFY_MEMBER, CHAT_TYPE_COMMAND);
      return true;
    }
    return ctx.send(GameActionType.RemoveAllegianceOfficer, (w) => w.writeString16(name));
  }
  if (sameWord(sub, 'set') || sameWord(sub, 'add')) {
    const lvl = strtol0(nextArg(rest));
    if (lvl < 1 || lvl > 3) {
      run.reply('Please specify a valid officer level as a number between 1 and 3. Check the game help files for more information on officer levels.', CHAT_TYPE_COMMAND);
      return true;
    }
    const name = joinArgsAsName(rest);
    if (name === '') {
      run.reply(PLEASE_SPECIFY_MEMBER, CHAT_TYPE_COMMAND);
      return true;
    }
    return ctx.send(GameActionType.SetAllegianceOfficer, (w) => { w.writeString16(name); w.writeUInt32(lvl); });
  }
  return false;
}

/**
 * DoAllegianceOfficerTitle @ 00576a10 (362220-362316). Retail quirks: no
 * empty-title check on set, and `add` is NOT an alias of `set` here.
 */
function doAllegianceOfficerTitle(run: Run, argv: string[]): boolean {
  const ctx = run.ctx;
  if (argv.length === 0) return ctx.send(GameActionType.ListAllegianceOfficerTitles);
  const rest = argv.slice();
  const sub = nextArg(rest);
  if (sameWord(sub, 'list')) return ctx.send(GameActionType.ListAllegianceOfficerTitles);
  if (sameWord(sub, 'clear')) return ctx.send(GameActionType.ClearAllegianceOfficerTitles);
  if (sameWord(sub, 'set')) {
    const lvl = strtol0(nextArg(rest));
    if (lvl < 1 || lvl > 3) {
      run.reply('Please specify a valid officer level as a number between 1 and 3.', CHAT_TYPE_COMMAND);
      return true;
    }
    const title = joinArgsAsName(rest);
    return ctx.send(GameActionType.SetAllegianceOfficerTitle, (w) => { w.writeUInt32(lvl); w.writeString16(title); });
  }
  return false;
}

/**
 * DoAllegianceName @ 00576c80 (362321-362396). Retail quirk: `set` trims
 * whitespace but keeps a leading '+', and sends even an empty name.
 */
function doAllegianceName(run: Run, argv: string[]): boolean {
  const ctx = run.ctx;
  if (argv.length === 0) return ctx.send(GameActionType.QueryAllegianceName);
  const rest = argv.slice();
  const sub = nextArg(rest);
  if (sameWord(sub, 'set')) {
    const name = joinArgs(rest).trim();
    return ctx.send(GameActionType.SetAllegianceName, (w) => w.writeString16(name));
  }
  if (sameWord(sub, 'clear')) return ctx.send(GameActionType.ClearAllegianceName);
  return false;
}

/** AllegianceLockAction values (Event_DoAllegianceLockAction, 0x3F). */
const LOCK_OFF = 1, LOCK_ON = 2, LOCK_TOGGLE = 3, LOCK_CHECK = 4, LOCK_CHECK_APPROVED = 5, LOCK_CLEAR_APPROVED = 6;

/** DoAllegianceLock @ 00576e70 (362401-362514). */
function doAllegianceLock(run: Run, argv: string[]): boolean {
  const ctx = run.ctx;
  const lock = (action: number) => ctx.send(GameActionType.DoAllegianceLockAction, (w) => w.writeUInt32(action));
  if (argv.length === 0) return lock(LOCK_CHECK);
  const rest = argv.slice();
  const sub = nextArg(rest);
  if (sameWord(sub, 'off')) return lock(LOCK_OFF);
  if (sameWord(sub, 'on')) return lock(LOCK_ON);
  if (sameWord(sub, 'toggle')) return lock(LOCK_TOGGLE);
  if (sameWord(sub, 'check')) return lock(LOCK_CHECK);
  if (sameWord(sub, 'bypass')) {
    const name = joinArgsAsName(rest);
    if (name === '') return lock(LOCK_CHECK_APPROVED);
    if (sameWord(name, 'clear')) return lock(LOCK_CLEAR_APPROVED);
    return ctx.send(GameActionType.SetAllegianceApprovedVassal, (w) => w.writeString16(name));
  }
  return false;
}

/**
 * DoAllegianceHouse @ 0056ef70 (357219-357340). Fewer than two words →
 * CheckStatus (1), so "@allegiance house guest" also checks status. Words
 * after the second are ignored.
 */
function doAllegianceHouse(run: Run, argv: string[]): boolean {
  const house = (action: number) => run.ctx.send(GameActionType.DoAllegianceHouseAction, (w) => w.writeUInt32(action));
  if (argv.length < 2) return house(1);
  const rest = argv.slice();
  const a = nextArg(rest);
  const b = nextArg(rest);
  if (sameWord(a, 'guest')) {
    if (sameWord(b, 'open')) return house(2);
    if (sameWord(b, 'close')) return house(3);
  } else if (sameWord(a, 'storage')) {
    if (sameWord(b, 'open')) return house(4);
    if (sameWord(b, 'close')) return house(5);
  }
  return false;
}

/**
 * DoAllegianceHometown @ 0056ef10 (357189-357216): @alh / @ah. A failed
 * send returns false ("That is not a valid command.").
 */
function doAllegianceHometown(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply('This command takes no arguments!', CHAT_TYPE_COMMAND);
    return true;
  }
  return run.ctx.send(GameActionType.RecallAllegianceHometown);
}

/**
 * DoMotd @ 00577150 (362518-362590). Retail quirk: `set` has no trim and
 * no empty check, so "@motd set" sends an empty MOTD.
 */
function doMotd(run: Run, argv: string[]): boolean {
  const ctx = run.ctx;
  if (argv.length === 0) return ctx.send(GameActionType.QueryMotd);
  const rest = argv.slice();
  const sub = nextArg(rest);
  if (sameWord(sub, 'set')) {
    const text = joinArgs(rest);
    return ctx.send(GameActionType.SetMotd, (w) => w.writeString16(text));
  }
  if (sameWord(sub, 'clear')) return ctx.send(GameActionType.ClearMotd);
  return false;
}

/** DoSpeaker @ 0057dab0 (368661-368680): retired; arguments ignored, nothing sent. */
function doSpeaker(run: Run): boolean {
  run.reply('This command is no longer in use, please see @allegiance officer.\n', CHAT_TYPE_DEFAULT);
  return true;
}

// ── friends (DoFriends + the gmFriendsUI notice receivers) ──

/**
 * gmFriendsUI::RecvNotice_ChatCommand_DisplayFriends @ 0048d760
 * (143552-143715). Every line is type 0, window 0.
 */
function displayFriends(ctx: AllegianceSocialCommandContext, onlineOnly: boolean): void {
  const list = ctx.friends();
  if (list.length === 0) {
    ctx.print('Your friends list is empty!\n', CHAT_TYPE_DEFAULT, ALL_WINDOWS);
    return;
  }
  ctx.print('Your friends:\n', CHAT_TYPE_DEFAULT, ALL_WINDOWS);
  let printed = false;
  for (const f of list) {
    if (f.online) {
      ctx.print(`  ${f.name} (Online)\n`, CHAT_TYPE_DEFAULT, ALL_WINDOWS);
      printed = true;
    } else if (!onlineOnly) {
      ctx.print(`  ${f.name}\n`, CHAT_TYPE_DEFAULT, ALL_WINDOWS);
      printed = true;
    }
  }
  if (!printed) ctx.print('  You have no friends that are online.\n', CHAT_TYPE_DEFAULT, ALL_WINDOWS);
}

/** DoFriends @ 0057bc00 (367042-367130). */
function doFriends(run: Run, argv: string[]): boolean {
  const rest = argv.slice();
  const sub = nextArg(rest);
  if (run.ctx.serverFriends1999) {
    run.ctx.serverFriends1999(sub.toLowerCase(), joinArgsAsName(rest));
    return true;
  }
  if (sameWord(sub, 'add')) return doFriendsAdd(run, rest);
  if (sameWord(sub, 'remove')) return doFriendsRemove(run, rest);
  if (sameWord(sub, 'online')) {
    displayFriends(run.ctx, true);
    return true;
  }
  // ACE's FriendsOldHandler answers "That command is not used in the emulator."
  if (sameWord(sub, 'old')) return run.ctx.sendFriendsOld();
  if (sub === '') {
    displayFriends(run.ctx, false);
    return true;
  }
  run.reply('Invalid friends command specified.', CHAT_TYPE_COMMAND);
  return true;
}

/**
 * DoFriendsAdd @ 00578fb0 (364574-364610) → gmFriendsUI::Request_AddFriend
 * @ 0048d240 (143192): 50 or more friends → weenie error 0x561
 * (MaxFriendsExceeded), else Event_AddFriend(name).
 */
function doFriendsAdd(run: Run, argv: string[]): boolean {
  const name = joinArgsAsName(argv);
  if (name === '') {
    run.reply('You must specify the name of the friend you wish to add.', CHAT_TYPE_COMMAND);
    return true;
  }
  const ctx = run.ctx;
  if (ctx.friends().length > 0x31) ctx.weenieError(0x561);
  else ctx.send(GameActionType.AddFriend, (w) => w.writeString16(name));
  return true;
}

/**
 * DoFriendsRemove @ 00579080 (364615-364665). "-all" → RemoveAllFriends
 * receiver (144041): Event_ClearFriends, clear the panel, confirm. Anything
 * else → RemoveFriend receiver (143730): the first stored friend whose name
 * (leading '+' trimmed) matches case-insensitively is removed BY GUID; no
 * match → weenie error 0x563 (ThatCharacterNotOnYourFriendsList).
 */
function doFriendsRemove(run: Run, argv: string[]): boolean {
  const name = joinArgsAsName(argv);
  const ctx = run.ctx;
  if (name === '') {
    run.reply('You must specify the name of the friend you wish to remove.', CHAT_TYPE_COMMAND);
    return true;
  }
  if (sameWord(name, '-all')) {
    ctx.send(GameActionType.RemoveAllFriends);
    ctx.clearFriends();
    ctx.print('Your friends list has been cleared.\n', CHAT_TYPE_DEFAULT, ALL_WINDOWS);
    return true;
  }
  const hit = ctx.friends().find((f) => sameWord(f.name.replace(/^\++/, ''), name));
  if (!hit) ctx.weenieError(0x563);
  else ctx.send(GameActionType.RemoveFriend, (w) => w.writeUInt32(hit.id >>> 0));
  return true;
}

// ── squelch ──

/** LogTextTypeEnumMapper::LogTextTypeFromString @ 006b0590 (647676): case-insensitive name → ChatMessageType. */
const LOG_TEXT_TYPES: ReadonlyArray<readonly [string, number]> = [
  ['Default', 0], ['Speech', 2], ['Tell', 3], ['Speech_Direct_Send', 4], ['World_Broadcast', 0x14],
  ['System', 5], ['Combat', 6], ['Combat_Enemy', 0x15], ['Combat_Self', 0x16], ['Magic', 7],
  ['Channel', 8], ['Channel_Send', 9], ['Social', 0xa], ['Social_Send', 0xb], ['Emote', 0xc],
  ['Advancement', 0xd], ['Abuse', 0xe], ['Help', 0xf], ['All', 1], ['Spellcasting', 0x11],
  ['Appraisal', 0x10], ['Assessment', 0x10], ['Allegiance', 0x12], ['Fellowship', 0x13],
  ['Recall', 0x17], ['Craft', 0x18], ['Salvaging', 0x19], ['Admin_Tell', 0x1f],
];

/** LogTextTypeFromString: the type for a name, or null. */
export function logTextTypeFromString(name: string): number | null {
  for (const [n, t] of LOG_TEXT_TYPES) if (sameWord(name, n)) return t;
  return null;
}

/** ProcessSquelchArgs' outputs. */
export interface SquelchArgs {
  account: boolean;
  name: string;
  type: number;
}

/**
 * ProcessSquelchArgs @ 00579c30 (365197-365366). Returns null only for an
 * invalid category (the one path that returns false). Retail quirk: the
 * "-reply with no teller" and "no target" paths print their error and
 * STILL return true, so the caller sends with an empty name.
 */
export function processSquelchArgs(run: CommandRun<AllegianceSocialCommandContext>, argv: readonly string[], requireTarget: boolean): SquelchArgs | null {
  const out: SquelchArgs = { account: false, name: '', type: 1 };
  if (argv.length < 1) {
    run.reply('Not enough arguements.', CHAT_TYPE_COMMAND); // sic
    return out;
  }
  let i = 0;
  let reply = false;
  for (; i < argv.length; i++) {
    const word = argv[i];
    if (word.charAt(0) !== '-') break;
    const flag = word.slice(1);
    if (sameWord(flag, 'reply')) reply = true;
    else if (sameWord(flag, 'account')) out.account = true;
    else {
      const t = logTextTypeFromString(flag);
      if (t === null) {
        // The whole word, dash included (disasm 579ee2: pushes argv[i]).
        run.reply(`"${word}" is not a valid squelch category.`, CHAT_TYPE_COMMAND);
        return null;
      }
      out.type = t;
    }
  }
  if (reply) {
    out.name = run.ctx.lastTellerName();
    if (out.name === '') run.reply('A player must @tell you before you can squelch them with this command.', CHAT_TYPE_COMMAND);
    return out;
  }
  out.name = joinArgsAsName(argv.slice(i));
  if (requireTarget && out.name === '') run.reply('You have not specified a squelch target.', CHAT_TYPE_COMMAND);
  return out;
}

/**
 * gmCCommunicationSystem::DoSquelchQuery @ 0058a2c0 (379156-379245): one
 * type-0 line block to every window; false when there is no
 * CCommunicationSystem.
 */
function doSquelchQuery(ctx: AllegianceSocialCommandContext): boolean {
  const entries = ctx.squelchEntries();
  if (entries === null) return false;
  let text = '(account) denotes a character whose account has also been squelched.\nFormat: Name : List of squelched message types.\n--------\n';
  if (entries.length === 0) text += 'none\n';
  else {
    text += '\n';
    for (const e of entries) text += `  ${e}\n`;
  }
  ctx.print(text, CHAT_TYPE_DEFAULT, ALL_WINDOWS);
  return true;
}

/**
 * DoSquelch @ 0057bf50 (367186-367240) / DoUnSquelch @ 0057c070
 * (367246-367300): identical but for the add flag. With args they always
 * return true; only an invalid category stops the send.
 */
function modifySquelch(run: Run, argv: string[], add: boolean): boolean {
  if (argv.length === 0) return doSquelchQuery(run.ctx);
  const args = processSquelchArgs(run, argv, true);
  if (args === null) return true;
  const flag = add ? 1 : 0;
  if (!args.account) {
    run.ctx.send(GameActionType.ModifyCharacterSquelch, (w) => {
      w.writeUInt32(flag); w.writeUInt32(0); w.writeString16(args.name); w.writeUInt32(args.type >>> 0);
    });
  } else {
    // The type is dropped for an account squelch.
    run.ctx.send(GameActionType.ModifyAccountSquelch, (w) => { w.writeUInt32(flag); w.writeString16(args.name); });
  }
  return true;
}

// ── @title ──

/**
 * DoTitle @ 0057a640 (365830-365890): retitle the popup chat window the
 * command was typed in; nothing goes to the server. Retail quirk: 99+
 * characters is refused, though the text says 100.
 */
function doTitle(run: Run, argv: string[]): boolean {
  if (TALK_FOCUS_SOURCES.includes(run.source)) {
    run.reply('This command must be issued from a popup chat window.', CHAT_TYPE_DEFAULT);
    return true;
  }
  const t = joinArgs(argv);
  if (t === '') {
    run.reply('You must provide a new title for the window.', CHAT_TYPE_DEFAULT);
    return true;
  }
  if (t.length + 1 >= 100) {
    run.reply('Window title length cannot exceed 100 characters.', CHAT_TYPE_DEFAULT);
    return true;
  }
  run.ctx.setChatWindowTitle(run.source, t);
  return true;
}

/** The allegiance / social command-table entries (InitializeCommands @ 00581970). */
export function allegianceSocialCommandEntries(): CommandEntry<AllegianceSocialCommandContext>[] {
  return [
    { name: 'allegiances', handler: null, help: 'HelpAllegiancesGroup' },
    { name: 'allegiance', handler: doAllegiance, help: 'HelpAllegiance' },
    { name: 'all', handler: doAllegiance, help: 'HelpAllegiance' },
    { name: 'ab', handler: doAllegianceBroadcast, help: 'HelpAllegiance' },
    { name: 'alh', handler: doAllegianceHometown, help: 'HelpAllegiance' },
    { name: 'ah', handler: doAllegianceHometown, help: 'HelpAllegiance' },
    { name: 'motd', handler: doMotd, help: 'HelpMotd' },
    { name: 'speaker', handler: doSpeaker, help: 'HelpSpeaker' },
    { name: 'friends', handler: doFriends, help: 'HelpFriends' },
    { name: 'friends_add', handler: doFriendsAdd, help: 'HelpFriends' },
    { name: 'friends_remove', handler: doFriendsRemove, help: 'HelpFriends' },
    { name: 'squelch', handler: (run, argv) => modifySquelch(run, argv, true), help: 'HelpSquelch' },
    { name: 'unsquelch', handler: (run, argv) => modifySquelch(run, argv, false), help: 'HelpSquelch' },
    { name: 'title', handler: doTitle, help: 'HelpTitle' },
  ];
}
