/**
 * The 1999 client's @-command table (SWEEP1999.commands): the 38 names
 * ChatEntryField::ChatEntryField @ 0x00518970 registers, in its order, with
 * the 1999 handlers (CmdHandlers_Do* @ 0x51cc70-0x51efa0) and help texts
 * (CmdHandlers_Help*). A 1999 world builds this table instead of end of
 * retail's (EraClientRules.commandTable 'ac1999'); every other word falls
 * through as an unknown one does in both clients: the 1999 channel aliases
 * (ChatEntryField_DoChannelCommand @ 0x51a6b0, 0x005e5020), then the whole
 * line to the server as Event_Talk (0x0051a3e0), which is how the AC1999
 * server's own @-commands are reached.
 *
 * The names and help texts are nibble-swapped in client.exe
 * (`((b & 0xf) << 4) | (b >> 4)`); names @ 0x605100-0x60523c, help texts
 * from 0x60574c. The typos ("Avaliable", "subsitute", "mesasge",
 * "long-distant") and the cut-off @friends help are the binary's.
 *
 * Where a 1999 handler does what end of retail's does (the same strings, the
 * same message), the end-of-retail handler is reused (@age, @birth, @emote,
 * @notell, @say, @framerate). The rest are here.
 */
import { GameActionType } from '@ac/network';
import {
  CHAT_TYPE_COMMAND, CHAT_TYPE_DEFAULT,
  doChannelCommand1999, eventTalk, eventTalkDirect, getChannelId1999, sameWord, vendorShopPage,
  type CommandEntry, type CommandHandler, type CommandRun, type CoreCommandContext, type TellCandidate,
} from './CommandSystem.js';
import { chatCommandEntries } from './ChatCommands.js';
import { emoteStatusCommandEntries, type CommandPosition, type RenderPreference } from './EmoteStatusCommands.js';
import type { RetailCommandContext } from './index.js';

/** What the 1999 handlers read beyond the shared contexts. */
export interface Commands1999Context {
  /** The player's own name (CmdHandlers_HelpEmote's example line). */
  playerName?(): string;
}

type Ctx = RetailCommandContext & Commands1999Context;
type Run = CommandRun<Ctx>;
type Handler = CommandHandler<Ctx>;

// ── strings (client.exe) ──

/**
 * The 1999 client's version string, 0x0062f508 (0x004033c0): "%s Portal:%s" of the
 * TurbineBuildVersion resource "01.00.00.0000" read through "%d.%d.%d.%c%c%c%c.%c" and printed
 * back by 0x004032c0 with _snprintf(buf, 15, "%2.2d.%2.2d.%2.2d.%c%c%c%c.%c"), and the VERSIONINFO
 * Comments "compiled Fri Oct 08 22:54:20 1999 : Release". The '.' after "0000" is that format's
 * literal, so it always prints. The last %c is byte 7 of the version struct, a stack local
 * (`lea ecx, [ebp-0x10]` @ 0x4033fb) that sscanf never reaches (the resource has no ".x" tail), so
 * it is unknown: it is left out here rather than guessed (a NUL ends the string there).
 * @version prints it, and ClientMode_RunTransition @ 0x4d08a0 prints it as the first chat line
 * on entering the world.
 */
export const AC1999_VERBOSE_VERSION = '01.00.00.0000. Portal:compiled Fri Oct 08 22:54:20 1999 : Release';

/** CmdHandlers_DoLifestone @ 0x51d4f0: PanelUI_ActivateRequestPanel's text (its three layout newlines dropped). */
export const LIFESTONE_CONFIRM_1999 = 'Do you really want to kill your character?';

/** CmdHandlers_DoHelp's header, 0x00605ad4 (sic). */
export const HELP_HEADER_1999 = 'Avaliable commands:\n  Note: You can subsitute a / for the @\n';
/** CmdHandlers_DoHelp: an unknown or help-less name (SetStatusText, urgent). */
export const HELP_UNKNOWN_1999 = 'Unknown command.';

/** GraphicsOptions_HandleRenderOption @ 0x42c085: the usage text (with the 3dfx texpage line). */
export const RENDER_USAGE_1999 =
  'Usage:\n@render <option> <value>\n  radius #        : set landscape radius (between 5 and 25)\n  fov #           : set field of view (between 10 and 160)\n  texpage [off]   : toggles 3dfx texture paging system\n';

/** "Your location is Landblock: %08x, X: %.1f, Y: %.1f, Z: %.1f, H: %.1f\n" (CmdHandlers_DoLoc @ 0x51d620). */
export function locLine1999(p: CommandPosition, heading: number): string {
  const f = (v: number) => Math.fround(v).toFixed(1);
  return `Your location is Landblock: ${(p.objcellId >>> 0).toString(16).padStart(8, '0')}, X: ${f(p.origin.x)}, Y: ${f(p.origin.y)}, Z: ${f(p.origin.z)}, H: ${f(heading)}\n`;
}

/** Frame::get_heading of a Position's quaternion: (450 − atan2(fy, fx)) mod 360 of its +y axis. */
export function headingOfPosition(p: CommandPosition): number {
  const { w, x, y, z } = p.quat;
  // The rotated +y axis's x / y components.
  const fx = 2 * (x * y - w * z);
  const fy = 1 - 2 * (x * x + z * z);
  if (Math.hypot(fx, fy) < 0.0002) return 0;
  const h = (450 - (Math.atan2(fy, fx) * 180) / Math.PI) % 360;
  return h < 0 ? h + 360 : h;
}

/** ChannelSystem_GetChannelName for the four channels @f / @m / @p / @v name. */
const CHANNEL_NAMES_1999: Readonly<Record<number, string>> = { 0x800: 'Fellowship', 0x1000: 'Vassals', 0x2000: 'Patron', 0x4000: 'Monarch' };

// ── targeted chat (ChatEntryField_TargetedChat @ 0x51a0c0) ──

/** What ChatEntryField_TargetedChat does with a tell to `name`. */
export type TargetedChat1999 =
  | { kind: 'shop'; id: number; page: 'buy' | 'sell' }
  | { kind: 'direct'; id: number }
  | { kind: 'byName' };

/**
 * ChatEntryField_TargetedChat @ 0x51a0c0: walk the objects the client holds. A vendor, when the
 * tell is addressed to "vendor" or "shopkeeper", or a vendor of that name: a "buy" / "sell" text
 * opens its shop. An object of that name (one leading '+' ignored, any case) closer than the
 * radar range less one metre gets Event_TalkDirect by guid. Otherwise Event_TalkDirectByName.
 */
export function targetedChat1999(name: string, text: string, objects: readonly TellCandidate[], radarRange: number): TargetedChat1999 {
  const generic = sameWord(name, 'vendor') || sameWord(name, 'shopkeeper');
  for (const o of objects) {
    if (o.vendor && generic) {
      const page = vendorShopPage(text);
      if (page) return { kind: 'shop', id: o.id, page };
    }
    const own = o.name.startsWith('+') ? o.name.slice(1) : o.name;
    if (!own || !sameWord(own, name)) continue;
    if (o.vendor) {
      const page = vendorShopPage(text);
      if (page) return { kind: 'shop', id: o.id, page };
    }
    if (o.distance < radarRange - 1) return { kind: 'direct', id: o.id };
  }
  return { kind: 'byName' };
}

/** Event_TalkDirectByName 0x5D: text, then the target name. */
function talkDirectByName(ctx: CoreCommandContext, text: string, name: string): boolean {
  return ctx.send(GameActionType.Tell, (w) => { w.writeString16(text); w.writeString16(name); });
}

/** Run ChatEntryField_TargetedChat for a tell to `name`. */
function targetedChat(ctx: Ctx, name: string, text: string): void {
  const plan = targetedChat1999(name, text, ctx.tellCandidates?.() ?? [], ctx.radarRange?.() ?? 0);
  if (plan.kind === 'shop') ctx.useVendor?.(plan.id, plan.page);
  else if (plan.kind === 'direct') eventTalkDirect(ctx, text, plan.id);
  else talkDirectByName(ctx, text, name);
}

// ── handlers ──

/** The handler's argument string: the line after the command word, leading spaces skipped (0x0051a3e0's local_1c). */
function rest(run: Run): string {
  return run.line.replace(/^\S+ */, '');
}

/** "Unexpected arguments to " + the command word (two urgent status pieces). */
function unexpectedArguments(run: Run): void {
  run.reply(`Unexpected arguments to @${run.command}`, CHAT_TYPE_COMMAND);
}

/** CmdHandlers_DoChatToggle @ 0x51cef0: on / off set the client-side switch; any other word does nothing. */
const doChat: Handler = (run, argv) => {
  if (argv.length !== 1) {
    run.reply('Please specify if you want chat text on or off.', CHAT_TYPE_COMMAND);
    return true;
  }
  const on = sameWord(argv[0], 'on');
  if (on || sameWord(argv[0], 'off')) {
    const line = run.ctx.setLocalChatSquelched?.(!on);
    if (line !== undefined) run.reply(line, CHAT_TYPE_DEFAULT);
  }
  return true;
};

/** CmdHandlers_DoLifestone @ 0x51d4f0: no arguments → the Yes / No panel; Yes sends 0x63, which kills the player. */
const doLifestone: Handler = (run, argv) => {
  if (argv.length !== 0) return false;
  // CM_Character_Event_Lifestone (0x63): our Suicide, which the 1999 adapter writes as 0x63.
  run.ctx.confirm(LIFESTONE_CONFIRM_1999, () => { run.ctx.send(GameActionType.Suicide); });
  return true;
};

/** CmdHandlers_DoFriends @ 0x51e240: add / remove need a name (else not a valid command); any other word lists. */
const doFriends: Handler = (run, argv) => {
  const send = run.ctx.serverFriends1999;
  if (!send) return false;
  const sub = argv[0] ?? '';
  if (sameWord(sub, 'add') || sameWord(sub, 'remove')) {
    if (argv.length < 2) return false;
    send(sub.toLowerCase(), rest(run).replace(/^\S+ /, ''));
    return true;
  }
  send('', '');
  return true;
};

/** CmdHandlers_DoFriendsAdd @ 0x51e390 / DoFriendsRemove @ 0x51e4c0: the name is the whole argument string. */
function friendsChange(sub: 'add' | 'remove'): Handler {
  return (run, argv) => {
    const send = run.ctx.serverFriends1999;
    if (!send || argv.length === 0) return false;
    send(sub, rest(run));
    return true;
  };
}

/**
 * CmdHandlers_DoStupidChannelHack @ 0x527380 (@f / @m / @p / @v): no text → "You must specify the
 * text you wish to broadcast!"; else the first space becomes ',' and DoChannelCommand broadcasts.
 */
const doChannelWord: Handler = (run, argv) => {
  if (argv.length < 1) {
    run.reply('You must specify the text you wish to broadcast!', CHAT_TYPE_COMMAND);
    return true;
  }
  return doChannelCommand1999(run.ctx, `${run.command},${rest(run)}`);
};

/**
 * CmdHandlers_DoTell @ 0x51e010 (@tell, @t): one leading '+' dropped; nothing typed → silent; no
 * comma → the usage line; the name (at most 32 characters) is kept for @retell even when the text
 * is empty, which sends nothing; else its trailing spaces are trimmed and TargetedChat sends it.
 */
const doTell: Handler = (run) => {
  let s = rest(run);
  if (s.startsWith('+')) s = s.slice(1);
  if (s === '') return true;
  const comma = s.indexOf(',');
  if (comma < 0) {
    run.reply('Use comma after the name for targeted chat.', CHAT_TYPE_COMMAND);
    return true;
  }
  const cut = s.slice(0, Math.min(comma, 0x20));
  const text = s.slice(comma + 1).replace(/^ +/, '');
  // The name buffer is trimmed only when there is text to send.
  const name = text === '' ? cut : cut.replace(/ +$/, '');
  run.ctx.setLastTelleeName(name);
  if (text !== '') targetedChat(run.ctx, name, text);
  return true;
};

/** CmdHandlers_DoReTell @ 0x51da00: TargetedChat to the name @tell kept. */
const doReTell: Handler = (run) => {
  const text = rest(run);
  if (text === '') return true;
  const name = run.ctx.lastTelleeName();
  if (name === '') {
    run.reply('You must first provide a name using @tell', CHAT_TYPE_COMMAND);
    return true;
  }
  targetedChat(run.ctx, name, text);
  return true;
};

/** CmdHandlers_DoReply @ 0x51db00: the last teller becomes the @retell name, then TalkDirect to its guid. */
const doReply: Handler = (run) => {
  const text = rest(run);
  if (text === '') {
    run.reply('You must specify the text you wish to say!', CHAT_TYPE_COMMAND);
    return true;
  }
  const teller = run.ctx.lastTeller();
  if (teller === 0) {
    run.reply('Someone must @tell you first!', CHAT_TYPE_COMMAND);
    return true;
  }
  run.ctx.setLastTelleeName(run.ctx.lastTellerName());
  eventTalkDirect(run.ctx, text, teller);
  return true;
};

/**
 * CmdHandlers_DoSquelch @ 0x51df40 / DoUnSquelch @ 0x51e1e0: no name → "Specify the player you
 * wish to (un)squelch."; else the whole argument string is the name (Event_SquelchByName; our
 * ModifyCharacterSquelch, which the 1999 adapter writes as 0x58 / 0x59).
 */
function squelch(add: boolean): Handler {
  return (run, argv) => {
    if (argv.length === 0) {
      run.reply(`Specify the player you wish to ${add ? 'squelch' : 'unsquelch'}.`, CHAT_TYPE_COMMAND);
      return true;
    }
    const name = rest(run);
    run.ctx.send(GameActionType.ModifyCharacterSquelch, (w) => {
      w.writeUInt32(add ? 1 : 0); w.writeUInt32(0); w.writeString16(name); w.writeUInt32(1);
    });
    return true;
  };
}

/** CmdHandlers_DoLoc @ 0x51d620. */
const doLoc: Handler = (run, argv) => {
  if (argv.length !== 0) {
    unexpectedArguments(run);
    return true;
  }
  const pos = run.ctx.playerPosition();
  if (!pos) return true;
  if ((pos.objcellId >>> 0) === 0) {
    run.reply('@Loc: not in valid cell!', CHAT_TYPE_DEFAULT);
    return true;
  }
  run.reply(locLine1999(pos, headingOfPosition(pos)), CHAT_TYPE_DEFAULT);
  return true;
};

/** CmdHandlers_DoVersion @ 0x51e670: "Client version " + the 1999 build string. */
const doVersion: Handler = (run, argv) => {
  if (argv.length !== 0) {
    unexpectedArguments(run);
    return true;
  }
  run.reply(`Client version ${AC1999_VERBOSE_VERSION}\n`, CHAT_TYPE_DEFAULT);
  return true;
};

/**
 * GraphicsOptions_HandleRenderOption @ 0x42c085 via CmdHandlers_DoRenderOption @ 0x51d970. The
 * 1999 argv still holds the command word, so the option is the first argument (end of retail's
 * reads the second). Errors are urgent status text, the usage text a chat line; usage returns
 * false ("That is not a valid command.").
 */
const doRender: Handler = (run, argv) => {
  if (!run.ctx.hasSmartBox()) return false;
  const opt = argv[0];
  if (opt === undefined || sameWord(opt, 'usage')) {
    run.reply(RENDER_USAGE_1999, CHAT_TYPE_DEFAULT);
    return false;
  }
  const value = (word: string | undefined) => (/^\s*[+-]?\d+/.test(word ?? '') ? parseInt(word!, 10) >>> 0 : 0);
  const range = (pref: RenderPreference, lo: number, hi: number, missing: string, bad: string, ok: string) => {
    if (argv.length < 2) return run.reply(missing, CHAT_TYPE_COMMAND);
    const v = value(argv[1]);
    if (v < lo || v > hi) return run.reply(bad, CHAT_TYPE_COMMAND);
    run.ctx.modifyRenderPreference(pref, v);
    run.reply(ok, CHAT_TYPE_COMMAND);
  };
  if (sameWord(opt, 'detail')) run.reply('Please use the Graphics/Options panel to change detail texture settings', CHAT_TYPE_COMMAND);
  else if (sameWord(opt, 'radius')) range('Render_LandscapeDrawDistance', 5, 25, 'Must specify a radius', 'Radius must be between 5 and 25', 'Landscape radius set');
  else if (sameWord(opt, 'fov')) range('Render_FieldOfView', 10, 160, 'Must specify a field of view', 'Field of view must be between 10 and 160', 'Field of view set');
  // 0x0040b730: the 3dfx test; a browser has no 3dfx chipset.
  else if (sameWord(opt, 'texpage')) run.reply('Texture paging is used only for 3dfx chipsets', CHAT_TYPE_COMMAND);
  return true;
};

/** CmdHandlers_DoLogopolis @ 0x51d5e0: a developer toggle of an unidentified panel (+0x2c4); no arguments only. */
const doLogopolis: Handler = (_run, argv) => argv.length === 0;

/** CmdHandlers_DoThroughPut @ 0x51efa0: advocates only (the packet-throughput meter, which this client has not). */
const doThroughput: Handler = (run, argv) => {
  if (!run.ctx.isPsr()) return false;
  if (argv.length !== 0) unexpectedArguments(run);
  return true;
};

/**
 * The advocate commands (@attackable, @bestow, @remove, @tele, @teleto, @save; DoAttackable
 * @ 0x51e720 …): a non-advocate gets "That is not a valid command."; an advocate's line goes to
 * the server, whose own @-commands carry them.
 */
const doAdvocate: Handler = (run) => {
  if (!run.ctx.isPsr()) return false;
  eventTalk(run.ctx, run.line);
  return true;
};

// ── @help (CmdHandlers_DoHelp @ 0x51d0c0 and the Help* functions) ──

/** A 1999 Help* function: the short line (the list) or the long text (@help <name>), or null (not listed / "Unknown command."). */
type Help1999 = (brief: boolean, name: string, ctx: Ctx) => string | null;

const fixed = (long: string, short: string): Help1999 => (brief) => (brief ? short : long);
const advocateOnly = (help: Help1999): Help1999 => (brief, name, ctx) => (ctx.isPsr() ? help(brief, name, ctx) : null);
/** HelpAge / HelpBirth: an advocate's text names the selected target; long = "usage: @x\n" + short + "\n". */
const statusHelp = (usage: string, own: string, advocate: string): Help1999 => (brief, _name, ctx) => {
  const short = ctx.isPsr() ? advocate : own;
  return brief ? short : `${usage}${short}\n`;
};

/** The 1999 Help* texts, by function name (decoded from client.exe). */
export const HELP_TEXTS_1999: Readonly<Record<string, Help1999>> = {
  HelpAge: statusHelp('usage: @age\n', 'Displays your total gameplay time.', "Displays your (or the selected target's) total gameplay time."),
  HelpBirth: statusHelp('usage: @birth\n', 'Displays when your character was created.', "Displays when your (or the selected target's) character was created."),
  HelpChatToggle: fixed(
    'usage: @chat {on,off}\nWhen set to off, you will no longer receive any spoken speech.  You will still receive tells, however.\n',
    'Sets whether you receive normal chat or not.'),
  HelpEmote: (brief, _name, ctx) => (brief ? 'Used to emote some text.'
    : 'usage: @emote text\nThis command causes your player to emote some text.  You can use these emotes to make your player perform some action in the third person.  For example, if you type "@emote looks around the town curiously.", then everyone around you would see "'
      + (ctx.playerName?.() ?? '')
      + ' looks around the town curiously."\n\nThis command can also be invoked by @e, @em, @me, or by simply starting your speech with a ; or a :\n'),
  // Cut off after "with" in the binary itself.
  HelpFriends: fixed(
    'Usage: @friends\nShows your current friends list and indicates if any of them are online.\nYou may place up to 20 names in your friends list.  Whenever one of the\ncharacters in your friends list logs into this game world, will be \nnotified by a short message in your chat window.  You add and remove \nnames from your friends list using @friends_add <name> or \n@friends_remove <name>.  You can clear your friends list with\n',
    'Tells you when friends log in'),
  HelpFriendsAdd: fixed('Usage: @friends_add <name>\nAdds a name to your friends list\n', 'Adds a character to your friends list.'),
  HelpFriendsRemove: fixed('Usage: @friends_remove <name>\nRemoves a name from your friends list\n', 'Removes a character from your friends list.'),
  HelpStupidChannelHack: (brief, name) => {
    const channel = CHANNEL_NAMES_1999[getChannelId1999(name.replace(/^@/, ''))] ?? '';
    return brief ? `Sends a broadcast to your ${channel}.` : `usage: ${name} text\nSends a broadcast mesasge to your ${channel}.\n`;
  },
  HelpLifestone: fixed(
    'usage: @lifestone\nThis command kills your character.  You can use this if you are stuck and you wish to return to the last lifestone that you used.  Be warned:  Normal death rules apply.\n',
    'Kills your character.'),
  HelpLoc: fixed(
    'usage: @loc\nDisplays to the chat box your current position.  Use this information when you wish to submit a bug report.\n',
    'Displays your current position.'),
  // The byte after "{on,off}" is a swapped newline that decodes to a no-break space.
  HelpNoTell: fixed(
    'usage: @notell {on,off} This command toggles whether you receive @tell\'s or not.  When set to "on" you will not receive any @tell\'s.\n',
    "Toggles whether you receive @tell's or not."),
  HelpReTell: fixed("usage: @retell text\nThis command sends the specified text to the last person you @tell'd.\n", "Sends some text to the last person you @tell'd."),
  HelpReply: fixed(
    'usage: @reply text\nThis command sends the specified text to the last person who communicated to via @tell.\n',
    "Sends some text to the last person who @tell'd you."),
  HelpSay: fixed(
    "usage: @say text\nThis command broadcasts some text to the people around you.  This is useful when you have your normal default chat set to 'Talk to Fellows', for example.\n",
    'Says some text to everyone around you.'),
  HelpSquelch: fixed(
    'usage: @squelch name\nSquelches the specified character name.  You will no longer receive any text from this character.\n',
    'Squelches a player.'),
  HelpTell: fixed(
    "usage: @tell name, text\nThis command sends a long-distant message to the specified character.  Note that you must put a comma after the character's name.You can also use @t instead of @tell.\n",
    'Sends a long-distance message to a character.'),
  HelpAttackable: advocateOnly(fixed(
    'usage: @attackable {on,off}\nThis command sets whether monsters will attack you unprovoked.  When turned on, monsters will attack you as if you are a normal player.  When turned off, monsters will ignore you.\n',
    'Sets whether monsters will attack you or not.')),
  HelpBestow: advocateOnly((brief, name) => (sameWord(name, '@remove')
    ? (brief ? "Removes a character's advocate status." : "usage: @remove character\nRemove the specified character's advocate status.\n")
    : (brief ? 'Bestows a level of advocacy on a character.'
      : "usage: @bestow [-f] name level\nThis command bestows on the specified character a level of advocacy.  'level' is the character's new advocate level.  This should be a value between 1 and 5.  The -f flag forces the bestow and ignores any advocate requirement checks (i.e., completing of the advocate quest).\n"))),
  HelpTeleport: advocateOnly(fixed(
    'usage: @tele [name,] longitude latitude\nThis command teleports yourself (or the specified character) to the given longitude and latitude.\n',
    'Teleports you (or a player) to some location.')),
  HelpTeleTo: advocateOnly(fixed('usage: @teleto name\nThis command teleports you to the specified character.\n', 'Teleports you to the specified character.')),
  HelpSave: advocateOnly(fixed('usage: @save\nThis command sets your current position to be your sanctuary position.\n', 'Sets your sanctuary position.')),
};

/** The text a 1999 help entry gives, or null. */
function helpText(entry: CommandEntry<Ctx> | undefined, brief: boolean, name: string, ctx: Ctx): string | null {
  const fn = entry?.help ? HELP_TEXTS_1999[entry.help] : undefined;
  return fn ? fn(brief, name, ctx) : null;
}

/**
 * CmdHandlers_DoHelp @ 0x51d0c0 (@help, @?). No argument: one block, the header, then for each
 * entry whose help gives a line "  @name -- <short>", sorted by name (the red-black tree
 * 0x0051f480 keys on it). With one: a leading '/' becomes '@', '@' is added when missing, and
 * the long text prints, or "Unknown command." for a name with none.
 */
const doHelp: Handler = (run, argv) => {
  if (argv.length === 0) {
    const lines: string[] = [];
    for (const e of run.entries()) {
      const name = `@${e.name}`;
      const short = helpText(e, true, name, run.ctx);
      if (short !== null) lines.push(`${name} -- ${short}`);
    }
    lines.sort((a, b) => (a.split(' ')[0] < b.split(' ')[0] ? -1 : 1));
    run.reply(HELP_HEADER_1999 + lines.map((l) => `  ${l}\n`).join(''), CHAT_TYPE_DEFAULT);
    return true;
  }
  let word = argv[0];
  if (word.startsWith('/')) word = '@' + word.slice(1);
  if (!word.startsWith('@')) word = '@' + word;
  const long = helpText(run.lookup(word.slice(1)), false, word, run.ctx);
  if (long === null) run.reply(HELP_UNKNOWN_1999, CHAT_TYPE_COMMAND);
  else run.reply(long, CHAT_TYPE_DEFAULT);
  return true;
};

// ── the table ──

/** End-of-retail handlers the 1999 client's match (same strings, same message). */
function eorHandler(name: string): Handler {
  const e = [...chatCommandEntries(), ...emoteStatusCommandEntries()].find((x) => x.name === name);
  if (!e?.handler) throw new Error(`no end-of-retail handler for @${name}`);
  return e.handler as unknown as Handler;
}

/** The 1999 @-command table, in ChatEntryField::ChatEntryField's registration order (help keys into HELP_TEXTS_1999). */
export function ac1999CommandEntries(): CommandEntry<RetailCommandContext>[] {
  const emote = eorHandler('emote');
  const e = (name: string, handler: Handler, help: string | null): CommandEntry<Ctx> => ({ name, handler, help });
  const entries: CommandEntry<Ctx>[] = [
    e('?', doHelp, null),
    e('age', eorHandler('age'), 'HelpAge'),
    e('birth', eorHandler('birth'), 'HelpBirth'),
    e('chat', doChat, 'HelpChatToggle'),
    e('e', emote, 'HelpEmote'),
    e('em', emote, 'HelpEmote'),
    e('emote', emote, 'HelpEmote'),
    e('help', doHelp, null),
    e('friends', doFriends, 'HelpFriends'),
    e('friends_add', friendsChange('add'), 'HelpFriendsAdd'),
    e('friends_remove', friendsChange('remove'), 'HelpFriendsRemove'),
    e('f', doChannelWord, 'HelpStupidChannelHack'),
    e('lifestone', doLifestone, 'HelpLifestone'),
    e('loc', doLoc, 'HelpLoc'),
    e('logopolis', doLogopolis, null),
    e('m', doChannelWord, 'HelpStupidChannelHack'),
    e('me', emote, 'HelpEmote'),
    e('notell', eorHandler('notell'), 'HelpNoTell'),
    e('p', doChannelWord, 'HelpStupidChannelHack'),
    e('render', doRender, null),
    e('retell', doReTell, 'HelpReTell'),
    e('reply', doReply, 'HelpReply'),
    e('say', eorHandler('say'), 'HelpSay'),
    e('sepaku', doLifestone, null),
    e('squelch', squelch(true), 'HelpSquelch'),
    e('t', doTell, null),
    e('tell', doTell, 'HelpTell'),
    e('unsquelch', squelch(false), null),
    e('v', doChannelWord, 'HelpStupidChannelHack'),
    e('version', doVersion, null),
    e('attackable', doAdvocate, 'HelpAttackable'),
    e('bestow', doAdvocate, 'HelpBestow'),
    e('remove', doAdvocate, 'HelpBestow'),
    e('tele', doAdvocate, 'HelpTeleport'),
    e('teleto', doAdvocate, 'HelpTeleTo'),
    e('save', doAdvocate, 'HelpSave'),
    e('framerate', eorHandler('framerate'), null),
    e('throughput', doThroughput, null),
  ];
  return entries as unknown as CommandEntry<RetailCommandContext>[];
}
