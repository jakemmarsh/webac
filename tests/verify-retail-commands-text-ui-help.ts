/**
 * Retail text / UI / help chat commands (TextUiHelpCommands.ts +
 * RetailHelpTexts.ts), driven through the real CommandSystem dispatcher.
 * Spec: docs/retail-commands/text-ui-help.md, docs/retail-commands/help-texts.md.
 */
import { describe, expect, it } from 'vitest';
import { BinaryWriter, GameActionType } from '@ac/network';
import {
  CommandSystem,
  type ChatPose,
  type CommandEntry,
  type TurbineRoom,
} from '../packages/renderer/src/chat/commands/CommandSystem';
import {
  textUiHelpCommandEntries,
  type TextUiHelpCommandContext,
} from '../packages/renderer/src/chat/commands/TextUiHelpCommands';
import {
  HELP_AVAILABLE_LIST,
  HelpType,
  RETAIL_HELP_TEXTS,
  SQUELCH_CHANNEL_LIST,
  convertSquelchTypesToString,
  getChannelName,
  logTextTypeFromString,
  retailHelp,
} from '../packages/renderer/src/chat/commands/RetailHelpTexts';

const SRC = 8;
const NOTE = '\nNote: You may substitute a forward slash (/) for the at symbol (@).\n\n';
const MORE = 'For more information, type @help <command>.\n';

interface Printed { text: string; type: number; window: number }
interface Sent { type: GameActionType; bytes: number[] }

function bytes(write: (w: BinaryWriter) => void): number[] {
  const w = new BinaryWriter();
  write(w);
  return Array.from(w.toBuffer());
}
const u32s = (...v: number[]) => bytes((w) => v.forEach((x) => w.writeUInt32(x)));
const str16 = (s: string) => bytes((w) => w.writeString16(s));

class FakeCtx implements TextUiHelpCommandContext {
  printed: Printed[] = [];
  sent: Sent[] = [];
  cleared: number[] = [];
  squelch: Set<number> | null = new Set();
  teller = '';
  logOpen: string | null = null;
  logOpenOk = true;
  logOpens: string[] = [];
  files = new Map<string, string>();
  fileReads: string[] = [];
  saved: string[] = [];
  loaded: string[] = [];
  locked = false;
  lockSets: boolean[] = [];
  now = 0;

  print(text: string, type: number, window: number): void { this.printed.push({ text, type, window }); }
  send(type: GameActionType, write?: (w: BinaryWriter) => void): boolean {
    const w = new BinaryWriter();
    write?.(w);
    this.sent.push({ type, bytes: Array.from(w.toBuffer()) });
    return true;
  }
  talkFocus(): number { return 1; }
  lastSpeakableTarget(): number { return 0; }
  usingTurbineChat(): boolean { return false; }
  turbineRoom(_room: TurbineRoom): number { return 0; }
  sendTurbineChat(): boolean { return false; }
  hearsAllegianceChat(): boolean { return true; }
  isOlthoi(): boolean { return false; }
  globalChannelName(): string { return ''; }
  chatPose(_name: string): ChatPose | null { return null; }
  playPoseMotion(): boolean { return false; }
  gender(): number { return 1; }
  nowSeconds(): number { return this.now; }

  clearChatBuffer(windowId: number): void { this.cleared.push(windowId); }
  globalSquelchTypes(): ReadonlySet<number> | null { return this.squelch; }
  lastTellerName(): string { return this.teller; }
  closeChatLog(): string | null { const n = this.logOpen; this.logOpen = null; return n; }
  openChatLog(fileName: string): boolean {
    this.logOpens.push(fileName);
    if (!this.logOpenOk) return false;
    this.logOpen = fileName;
    return true;
  }
  readCommandFile(fileName: string): string | null { this.fileReads.push(fileName); return this.files.get(fileName) ?? null; }
  saveUiLayout(name: string): void { this.saved.push(name); }
  loadUiLayout(name: string): void { this.loaded.push(name); }
  uiLocked(): boolean { return this.locked; }
  setLockUI(locked: boolean): void { this.locked = locked; this.lockSets.push(locked); }
}

/** Stand-in entries from the other groups, so @help <word> can be driven here. */
const standIns: CommandEntry<TextUiHelpCommandContext>[] = [
  { name: 'die', handler: () => true, help: 'HelpDie' },
  { name: 'emote', handler: () => true, help: 'HelpEmote' },
  { name: 'squelch', handler: () => true, help: 'HelpSquelch' },
  { name: 'fellow', handler: () => true, help: 'HelpStupidChannelHack' },
  { name: 'c', handler: () => true, help: 'HelpStupidChannelHack' },
  { name: 'general', handler: () => true, help: 'HelpTurbineChat_General' },
  { name: 'channels', handler: null, help: 'HelpChannelsGroup' },
  { name: 'render', handler: () => true, help: null },
  { name: 'bogushelp', handler: () => true, help: 'HelpNoSuchFunction' },
];

function setup(extra: CommandEntry<TextUiHelpCommandContext>[] = standIns) {
  const ctx = new FakeCtx();
  const sys = new CommandSystem<TextUiHelpCommandContext>(ctx, [...textUiHelpCommandEntries(), ...extra]);
  const run = (line: string, source = SRC) => sys.onChatCommand(line, source);
  return { ctx, sys, run };
}

const NOARG_LIST =
  'Available help:\n@help allegiances - Commands to help you deal with your Allegiance.\n@help channels - How to communicate with people in your allegiance or fellowship.\n@help chatting - How to chat publically and privately.\n@help death - Commands for making, finding, and looting corpses.\n@help emote - How to perform text and action emotes.\n@help fillcomps - A command to help you buy components in bulk.\n@help friends - Commands to help you manage your friends list.\n@help house - Commands that help you manage your house, including guest and storage management.\n@help squelch - Commands that let you block out messages from other players.\n@help status - Commands that display useful information.\n@help text - Commands that help you manage your text window.\n@help commands - Lists all commands.\n';

const TEXT_GROUP =
  '@clear - Clears the chat box of all text.\n@filter - Commands to filter out incoming messages.\n@unfilter - Commands to remove filters from incoming messages.\n@loadfile - Reads in the given text file and executes each line in the chat entry field.\n@log - Commands to echo chat text to a logfile.\n@title <new title> - Sets the title of the popup chat window.\n';

const SQUELCH_TYPES_LINE = 'Squelch channels are as follows:\n  Speech, Tell, Combat, Magic, Emote, Appraisal, Spellcasting, Allegiance, Fellowship, Combat_Enemy, Combat_Self, Recall, Craft, Salvaging\n';

describe('the command table', () => {
  it('registers every text/UI/help name with its retail help function', () => {
    const map = Object.fromEntries(textUiHelpCommandEntries().map((e) => [e.name, e.help]));
    expect(map).toEqual({
      '?': null, help: null, commands: 'HelpAllGroup', text: 'HelpTextGroup',
      messagetypes: 'HelpMessageTypes', message_types: 'HelpMessageTypes', msgtypes: 'HelpMessageTypes', msg_types: 'HelpMessageTypes',
      saveui: 'HelpSaveUI', loadui: 'HelpLoadUI', saveautoui: 'HelpSaveAutoUI', loadautoui: 'HelpLoadAutoUI', lockui: 'HelpLockUI',
      clear: 'HelpClear', filter: 'HelpFilter', unfilter: 'HelpUnFilter', log: 'DoSetOutputHelp', loadfile: 'HelpLoadFile',
    });
    for (const e of textUiHelpCommandEntries()) {
      if (e.help) expect(retailHelp(e.help, HelpType.Detail, e.name, '')).not.toBeNull();
    }
  });

  it('group words have no handler: @commands / /text fall through to Event_Talk of the whole line', () => {
    const { ctx, run } = setup();
    run('@commands');
    run('/text now');
    expect(ctx.sent).toEqual([
      { type: GameActionType.Talk, bytes: str16('@commands') },
      { type: GameActionType.Talk, bytes: str16('@text now') },
    ]);
    expect(ctx.printed).toEqual([]);
  });
});

describe('DoHelp (@help, @?)', () => {
  it('no args: the Note line then the Available help list, both type 0 to the command window', () => {
    for (const line of ['@help', '/help', '@?', '/?', '@HELP']) {
      const { ctx, run } = setup();
      run(line);
      expect(ctx.printed).toEqual([
        { text: NOTE, type: 0, window: SRC },
        { text: NOARG_LIST, type: 0, window: SRC },
      ]);
      expect(ctx.sent).toEqual([]);
    }
    expect(HELP_AVAILABLE_LIST).toBe(NOARG_LIST);
  });

  it('@help <command>: Note, then "For more information…" + the Detail text', () => {
    const { ctx, run } = setup();
    run('@help die');
    expect(ctx.printed).toEqual([
      { text: NOTE, type: 0, window: SRC },
      {
        text: MORE + "@die - If you wish to kill your character and leave a corpse, you may use the @die command.  This will result in your character's death, you will leave behind a corpse with some of your items, and you will appear at your lifestone.  If you wish to travel to your lifestone without leaving behind a corpse, you may use the @lifestone command.\n",
        type: 0,
        window: SRC,
      },
    ]);
  });

  it('trims leading / and @ from the word, matches case-insensitively, and ignores further words', () => {
    for (const line of ['@help /die', '@help @@die', '/help DIE extra words', '@? /@die']) {
      const { ctx, run } = setup();
      run(line);
      expect(ctx.printed.map((p) => p.text)).toEqual([NOTE, MORE + RETAIL_HELP_TEXTS.HelpDie.detail]);
    }
  });

  it('@help text / @help channels print the group Detail listings', () => {
    let s = setup();
    s.run('@help text');
    expect(s.ctx.printed[1]).toEqual({ text: MORE + TEXT_GROUP, type: 0, window: SRC });
    s = setup();
    s.run('@help channels');
    expect(s.ctx.printed[1].text).toBe(MORE
      + '@a - Sends a broadcast to your Allegiance.\n@c - Sends a broadcast to your Co-vassals.\n@m - Sends a broadcast to your Monarch.\n@p - Sends a broadcast to your Patron.\n@v - Sends a broadcast to your Vassals.\n@f - Sends a broadcast to your Fellowship.\n');
  });

  it('@help commands keeps retail quirks: "@say …" runs into "@tell", @saveui/@loadui listed twice', () => {
    const { ctx, run } = setup();
    run('@help commands');
    const text = ctx.printed[1].text;
    expect(text.startsWith(MORE + '@allegiance - Commands to help manage your allegiance.\n')).toBe(true);
    expect(text).toContain('@say - Says some text to everyone around you.@tell - Sends a private message to another character.\n');
    expect(text.split('@saveui <filename> - Saves the current user interface.\n').length - 1).toBe(2);
    expect(text.split('@loadui <filename> - Loads a previously saved user interface.\n').length - 1).toBe(2);
    expect(text.endsWith(TEXT_GROUP)).toBe(true);
    expect(text).toContain('@day - A toggle that lightens the outdoor landscape. Note that this command may take several seconds to take effect. \n');
    expect(text.length).toBe(MORE.length + 3337);
  });

  it('@help squelch expands HelpAdvancedSquelch + HelpAdvancedUnSquelch', () => {
    const { ctx, run } = setup();
    run('@help squelch');
    const text = ctx.printed[1].text;
    expect(text.startsWith(MORE + 'The @squelch commands let you block out messages')).toBe(true);
    expect(text).toContain('\n\n@squelch - Shows the current list of squelched characters.\n');
    expect(text).toContain('\n\n@unsquelch - Shows the current list of squelched characters.\n');
    expect(text.endsWith('\n\nType @messagetypes for a complete list of message types.\n')).toBe(true);
  });

  it('@help messagetypes (all four names): HelpMessageTypes REPLACES the buffer, dropping the prefix', () => {
    for (const w of ['messagetypes', 'message_types', 'msgtypes', 'msg_types']) {
      const { ctx, run } = setup();
      run(`@help ${w}`);
      expect(ctx.printed).toEqual([
        { text: NOTE, type: 0, window: SRC },
        { text: SQUELCH_TYPES_LINE, type: 0, window: SRC },
      ]);
    }
  });

  it('channel-hack names echo the word as typed with the channel name', () => {
    let s = setup();
    s.run('@help fellow');
    expect(s.ctx.printed[1].text).toBe(MORE + '@fellow - Sends a broadcast to your Fellowship.\n');
    s = setup();
    s.run('@help /C');
    expect(s.ctx.printed[1].text).toBe(MORE + '@C - Sends a broadcast to your Co-vassals.\n');
  });

  it('other groups\' help functions are called through the table entry (Turbine chat, emote, log)', () => {
    let s = setup();
    s.run('@help general');
    expect(s.ctx.printed[1].text).toBe(MORE + '@general - Sends a message to the global General chat channel. Also: @cg\n');
    s = setup();
    s.run('@help emote');
    expect(s.ctx.printed[1].text).toBe(MORE + RETAIL_HELP_TEXTS.HelpEmote.detail);
    expect(RETAIL_HELP_TEXTS.HelpEmote.detail.endsWith('Type @emotes to see a list.\n\n')).toBe(true);
    s = setup();
    s.run('@help log');
    expect(s.ctx.printed[1].text).toBe(MORE + RETAIL_HELP_TEXTS.DoSetOutputHelp.detail);
    expect(s.ctx.printed[1].text).toContain('@log AClog.txt - Echoes chat text to a log file named Aclog.txt');
  });

  it('NULL help, unknown words, and unknown help functions print "Unknown command" (0x1a) with no Note', () => {
    for (const line of ['@help help', '@help ?', '@help render', '@help squelching', '@help nosuchthing', '@help bogushelp', '@help @']) {
      const { ctx, run } = setup();
      run(line);
      expect(ctx.printed).toEqual([{ text: 'Unknown command', type: 0x1a, window: SRC }]);
    }
  });
});

describe('DoMessageTypes', () => {
  it('every alias prints the squelch channel list, type 0, command window; args ignored', () => {
    for (const line of ['@messagetypes', '/message_types', '@msgtypes x y', '@MSG_TYPES']) {
      const { ctx, run } = setup();
      run(line, 3);
      expect(ctx.printed).toEqual([{ text: SQUELCH_TYPES_LINE, type: 0, window: 3 }]);
      expect(ctx.sent).toEqual([]);
    }
    expect(SQUELCH_CHANNEL_LIST).toBe(SQUELCH_TYPES_LINE);
  });
});

describe('DoClear', () => {
  it('clears the command window; "all" (any case) clears window 0; other args ignored', () => {
    const { ctx, run } = setup();
    run('@clear', 5);
    run('@clear all', 5);
    run('/clear ALL', 5);
    run('@clear foo all', 5);
    expect(ctx.cleared).toEqual([5, 0, 0, 5]);
    expect(ctx.printed).toEqual([]);
    expect(ctx.sent).toEqual([]);
  });
});

describe('DoFilter / DoUnFilter (PerformGlobalSquelchMod)', () => {
  const listing = (x: string) => 'The following types of messages are currently being filtered globally:\n'
    + x + '\n(For a list of filter options, type @help filter)\n';

  it('no args: the global filter listing, type 0, window 0, for both commands', () => {
    for (const cmd of ['@filter', '@unfilter']) {
      let s = setup();
      s.run(cmd);
      expect(s.ctx.printed).toEqual([{ text: listing('none'), type: 0, window: 0 }]);
      s = setup();
      s.ctx.squelch = new Set([0x11, 6, 0x08]);
      s.run(cmd);
      expect(s.ctx.printed).toEqual([{ text: listing('Combat, Spellcasting'), type: 0, window: 0 }]);
      s = setup();
      s.ctx.squelch = new Set([1, 3]);
      s.run(cmd);
      expect(s.ctx.printed).toEqual([{ text: listing('All message types'), type: 0, window: 0 }]);
      expect(s.ctx.sent).toEqual([]);
    }
  });

  it('no args without a communication system fails → "That is not a valid command."', () => {
    const { ctx, run } = setup();
    ctx.squelch = null;
    run('@filter');
    expect(ctx.printed).toEqual([{ text: 'That is not a valid command.', type: 0x1a, window: 0 }]);
  });

  it('a first word without a dash', () => {
    const { ctx, run } = setup();
    run('@filter tell');
    expect(ctx.printed).toEqual([{ text: 'You must specify a valid message type prefixed by a dash.', type: 0x1a, window: SRC }]);
    expect(ctx.sent).toEqual([]);
  });

  it('-type sends ModifyGlobalSquelch 0x5B (u32 add, u32 type); the last type wins', () => {
    const { ctx, run } = setup();
    run('@filter -tell');
    run('@unfilter -spellcasting');
    run('/filter -TELL -magic');
    run('@filter -assessment');
    run('@unfilter -all');
    run('@filter -tell +');
    expect(ctx.sent).toEqual([
      { type: GameActionType.ModifyGlobalSquelch, bytes: u32s(1, 3) },
      { type: GameActionType.ModifyGlobalSquelch, bytes: u32s(0, 0x11) },
      { type: GameActionType.ModifyGlobalSquelch, bytes: u32s(1, 7) },
      { type: GameActionType.ModifyGlobalSquelch, bytes: u32s(1, 0x10) },
      { type: GameActionType.ModifyGlobalSquelch, bytes: u32s(0, 1) },
      { type: GameActionType.ModifyGlobalSquelch, bytes: u32s(1, 3) },
    ]);
    expect(GameActionType.ModifyGlobalSquelch).toBe(0x5b);
    expect(ctx.printed).toEqual([]);
  });

  it('an unknown category prints the dash-less word (0x1a) and sends nothing', () => {
    const { ctx, run } = setup();
    run('@filter -bogus');
    run('@filter -tell -');
    expect(ctx.printed).toEqual([
      { text: '"-bogus" is not a valid squelch category.', type: 0x1a, window: SRC },
      { text: '"-" is not a valid squelch category.', type: 0x1a, window: SRC },
    ]);
    expect(ctx.sent).toEqual([]);
  });

  it('-account or a target name → "Incorrect usage, use @help for proper arguements."', () => {
    for (const line of ['@filter -tell Oswald', '@filter -account', '@unfilter -account -tell', '@filter -tell some name']) {
      const { ctx, run } = setup();
      run(line);
      expect(ctx.printed).toEqual([{ text: 'Incorrect usage, use @help for proper arguements.', type: 0x1a, window: SRC }]);
      expect(ctx.sent).toEqual([]);
    }
  });

  it('retail quirk: -reply with no last teller warns AND sends ModifyGlobalSquelch', () => {
    let s = setup();
    s.run('@filter -reply');
    expect(s.ctx.printed).toEqual([{ text: 'A player must @tell you before you can squelch them with this command.', type: 0x1a, window: SRC }]);
    expect(s.ctx.sent).toEqual([{ type: GameActionType.ModifyGlobalSquelch, bytes: u32s(1, 1) }]);
    s = setup();
    s.run('@unfilter -reply -tell ignored');
    expect(s.ctx.sent).toEqual([{ type: GameActionType.ModifyGlobalSquelch, bytes: u32s(0, 3) }]);
  });

  it('-reply with a last teller → "Incorrect usage…"', () => {
    const { ctx, run } = setup();
    ctx.teller = 'Oswald';
    run('@filter -reply -tell');
    expect(ctx.printed).toEqual([{ text: 'Incorrect usage, use @help for proper arguements.', type: 0x1a, window: SRC }]);
    expect(ctx.sent).toEqual([]);
  });
});

describe('DoSetOutput (@log)', () => {
  it('no args, nothing open → "Please specify a file to append chat messages to."', () => {
    const { ctx, run } = setup();
    run('@log');
    expect(ctx.printed).toEqual([{ text: 'Please specify a file to append chat messages to.\n', type: 0, window: SRC }]);
  });

  it('no args with a log open → closed line, then "Chat output now directed only to the screen."', () => {
    const { ctx, run } = setup();
    ctx.logOpen = 'chat.txt';
    run('@log');
    expect(ctx.printed).toEqual([
      { text: 'Chat log chat.txt closed.\n', type: 0, window: SRC },
      { text: 'Chat output now directed only to the screen.\n', type: 0, window: SRC },
    ]);
    expect(ctx.logOpen).toBeNull();
  });

  it('a name: ".txt" added when there is no extension; joined with single spaces', () => {
    const { ctx, run } = setup();
    run('@log AClog');
    run('@log my   chat');
    run('@log notes.log');
    run('@log dir.d/name');
    run('@log name.');
    expect(ctx.logOpens).toEqual(['AClog.txt', 'my chat.txt', 'notes.log', 'dir.d/name.txt', 'name.']);
    expect(ctx.printed[0]).toEqual({ text: 'Copying chat to AClog.txt.  Run command again with no arguments to turn off logging.\n', type: 0, window: SRC });
    // Each later @log closes the previous log first.
    expect(ctx.printed[1]).toEqual({ text: 'Chat log AClog.txt closed.\n', type: 0, window: SRC });
    expect(ctx.printed[2].text).toBe('Copying chat to my chat.txt.  Run command again with no arguments to turn off logging.\n');
  });

  it('an open failure replaces the success text', () => {
    const { ctx, run } = setup();
    ctx.logOpenOk = false;
    run('@log x');
    expect(ctx.printed).toEqual([{ text: 'Failed to redirect to file x.txt!\n', type: 0, window: SRC }]);
  });
});

describe('DoLoadFile', () => {
  it('no name / unreadable file (0x1a, command window, no newline)', () => {
    const { ctx, run } = setup();
    run('@loadfile');
    run('@loadfile missing  file.txt');
    expect(ctx.printed).toEqual([
      { text: 'You must provide a file name.', type: 0x1a, window: SRC },
      { text: 'Cannot open file missing file.txt', type: 0x1a, window: SRC },
    ]);
    expect(ctx.fileReads).toEqual(['missing file.txt']);
  });

  it('echoes each line (type 0) then runs it through OnChatCommand from the same window', () => {
    const { ctx, run } = setup();
    ctx.files.set('script.txt', '@clear all\r\nhello there\n\n/messagetypes');
    run('@loadfile script.txt', 4);
    expect(ctx.cleared).toEqual([0]);
    expect(ctx.printed).toEqual([
      { text: '@clear all', type: 0, window: 4 },
      { text: 'hello there', type: 0, window: 4 },
      { text: '', type: 0, window: 4 },
      { text: '/messagetypes', type: 0, window: 4 },
      { text: SQUELCH_TYPES_LINE, type: 0, window: 4 },
    ]);
    // Talk focus 1 (source 4 is not a talk-focus source either way): PublicChat → Event_Talk.
    expect(ctx.sent).toEqual([{ type: GameActionType.Talk, bytes: str16('hello there') }]);
  });

  it('%DATE% becomes strftime "%Y-%m-%d-%a" (local time)', () => {
    const { ctx, run } = setup();
    const when = new Date(2026, 9, 6, 12, 0, 0); // a Tuesday
    ctx.now = when.getTime() / 1000;
    ctx.files.set('d', 'say %DATE% and %DATE%');
    run('@loadfile d');
    expect(ctx.printed[0].text).toBe('say 2026-10-06-Tue and 2026-10-06-Tue');
  });

  it('fgets reads at most 1023 characters per line; nested @loadfile recurses', () => {
    const { ctx, run } = setup();
    ctx.files.set('long', 'x'.repeat(2100));
    run('@loadfile long');
    expect(ctx.printed.map((p) => p.text.length)).toEqual([1023, 1023, 54]);
    const s = setup();
    s.ctx.files.set('outer', '@loadfile inner\n@clear');
    s.ctx.files.set('inner', '@clear all');
    s.run('@loadfile outer');
    expect(s.ctx.printed.map((p) => p.text)).toEqual(['@loadfile inner', '@clear all', '@clear']);
    expect(s.ctx.cleared).toEqual([0, SRC]);
  });
});

describe('DoSaveUI / DoLoadUI / DoSaveAutoUI / DoLoadAutoUI', () => {
  it('saveui: none → default, one name ≤ 15 chars, 16 rejected (retail off-by-one), 2+ → usage', () => {
    const { ctx, run } = setup();
    run('@saveui');
    run('@saveui mylayout');
    run('@saveui ' + 'a'.repeat(15));
    run('@saveui ' + 'a'.repeat(16));
    run('@saveui two words');
    expect(ctx.saved).toEqual(['', 'mylayout', 'a'.repeat(15)]);
    expect(ctx.printed).toEqual([
      { text: 'The file name must be 16 characters or less.', type: 0x1a, window: SRC },
      { text: 'Please use @help saveui for proper usage.', type: 0x1a, window: SRC },
    ]);
    expect(ctx.loaded).toEqual([]);
  });

  it('loadui mirrors saveui with its own usage line', () => {
    const { ctx, run } = setup();
    run('/loadui');
    run('@loadui mylayout');
    run('@loadui ' + 'b'.repeat(16));
    run('@loadui a b c');
    expect(ctx.loaded).toEqual(['', 'mylayout']);
    expect(ctx.printed).toEqual([
      { text: 'The file name must be 16 characters or less.', type: 0x1a, window: SRC },
      { text: 'Please use @help loadui for proper usage.', type: 0x1a, window: SRC },
    ]);
    expect(ctx.saved).toEqual([]);
  });

  it('saveautoui / loadautoui use "#auto"; any argument → usage', () => {
    const { ctx, run } = setup();
    run('@saveautoui');
    run('@loadautoui');
    run('@saveautoui x');
    run('@loadautoui x');
    expect(ctx.saved).toEqual(['#auto']);
    expect(ctx.loaded).toEqual(['#auto']);
    expect(ctx.printed).toEqual([
      { text: 'Please use @help saveautoui for proper usage.', type: 0x1a, window: SRC },
      { text: 'Please use @help loadautoui for proper usage.', type: 0x1a, window: SRC },
    ]);
  });
});

describe('DoLockUI', () => {
  it('toggles LockUI and sends SetSingleCharacterOption (0x33, value)', () => {
    const { ctx, run } = setup();
    run('@lockui');
    run('/lockui');
    expect(ctx.lockSets).toEqual([true, false]);
    expect(ctx.sent).toEqual([
      { type: GameActionType.SetSingleCharacterOption, bytes: u32s(0x33, 1) },
      { type: GameActionType.SetSingleCharacterOption, bytes: u32s(0x33, 0) },
    ]);
    expect(GameActionType.SetSingleCharacterOption).toBe(0x0005);
    expect(ctx.printed).toEqual([]);
  });

  it('any argument → usage line, no toggle', () => {
    const { ctx, run } = setup();
    run('@lockui on');
    expect(ctx.printed).toEqual([{ text: 'Please use @help lockui for proper usage.', type: 0x1a, window: SRC }]);
    expect(ctx.lockSets).toEqual([]);
    expect(ctx.sent).toEqual([]);
  });
});

describe('RetailHelpTexts', () => {
  it('holds every retail Help* function with Summary / List / Detail', () => {
    const names = Object.keys(RETAIL_HELP_TEXTS);
    expect(names.length).toBe(62);
    for (const fn of ['HelpAllGroup', 'HelpChattingGroup', 'HelpDeathGroup', 'HelpStatusGroup', 'HelpTextGroup',
      'HelpChannelsGroup', 'HelpAllegiancesGroup', 'HelpEmote', 'HelpSquelch', 'HelpTurbineChat_Olthoi',
      'HelpAdvancedSquelch', 'HelpAdvancedUnSquelch', 'DoSetOutputHelp']) {
      expect(names).toContain(fn);
    }
    for (const fn of names) {
      const t = RETAIL_HELP_TEXTS[fn];
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.detail.length).toBeGreaterThan(0);
    }
  });

  it('keeps retail\'s own summary/detail differences and quirks', () => {
    expect(RETAIL_HELP_TEXTS.HelpSay.summary).toBe('@say - Says some text to everyone around you.');
    expect(RETAIL_HELP_TEXTS.HelpLoadUI.detail).toBe('@loadui <filename> - Loads a previously saved user interface layout from disk using the provided file name');
    expect(RETAIL_HELP_TEXTS.HelpLockUI.summary).toBe('@help lockui - Toggles the locked state of the UI layout.\n');
    expect(RETAIL_HELP_TEXTS.HelpLockUI.detail).toBe('@lockui - Toggles the locked state of the UI layout.\n');
    expect(RETAIL_HELP_TEXTS.HelpCorpse.list).toBe('@corpse - Displays the location of your last outdoor death.\n');
    expect(RETAIL_HELP_TEXTS.HelpAFK.detail).toContain('directed chatyou will receive');
    expect(RETAIL_HELP_TEXTS.HelpChattingGroup.detail).toContain('around you.@tell - ');
    expect(RETAIL_HELP_TEXTS.HelpLoadFile.detail).toBe('usage: @loadfile filename\nThis command reads in the specified text file and executes every line as if you typed it in the chat entry field.  Essentially, this plays a script.\n');
  });

  it('retailHelp appends (Summary / List / Detail), replaces for HelpMessageTypes, builds channel lines', () => {
    expect(retailHelp('HelpAge', HelpType.Summary, 'age', 'X')).toBe('X@age - Displays your total gameplay time.\n');
    expect(retailHelp('HelpEmote', HelpType.List, 'emote', '')).toBe('@emote - Performs a text emote.\n@emotes - Lists all standard emotes.\n');
    expect(retailHelp('HelpMessageTypes', HelpType.Summary, 'x', 'dropped')).toBe(SQUELCH_TYPES_LINE);
    expect(retailHelp('HelpStupidChannelHack', HelpType.Summary, 'party', 'A')).toBe('A@party - Sends a broadcast to your Fellowship.\n');
    expect(retailHelp('HelpStupidChannelHack', HelpType.Detail, 'nope', '')).toBe('@nope - Sends a broadcast to your .\n');
    expect(retailHelp('HelpNothing', HelpType.Detail, 'x', '')).toBeNull();
    expect(retailHelp('toString', HelpType.Detail, 'x', '')).toBeNull();
  });

  it('GetChannelName, LogTextTypeFromString and ConvertSQToPString', () => {
    expect(getChannelName(0x01000000)).toBe('Co-vassals');
    expect(getChannelName(0x20000000)).toBe('Radiant Blood');
    expect(getChannelName(0x123)).toBe('');
    expect(logTextTypeFromString('ASSESSMENT')).toBe(0x10);
    expect(logTextTypeFromString('admin_tell')).toBe(0x1f);
    expect(logTextTypeFromString('world_broadcast')).toBe(0x14);
    expect(logTextTypeFromString('Unknown')).toBeNull();
    expect(convertSquelchTypesToString(new Set(), true)).toBe('');
    expect(convertSquelchTypesToString(new Set([1, 2]), false)).toBe('Speech');
    expect(convertSquelchTypesToString(new Set([0x19, 2, 0x0e]), true)).toBe('Speech, Salvaging');
  });
});
