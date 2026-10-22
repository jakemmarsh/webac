/**
 * Retail chat commands, text / UI / help group: @help and @? (DoHelp), the
 * help-only group words "commands" and "text", @messagetypes (+ aliases),
 * @clear, @filter / @unfilter (PerformGlobalSquelchMod), @log
 * (DoSetOutput), @loadfile, @saveui, @loadui, @saveautoui, @loadautoui and
 * @lockui. Ported from the decompiled EoL acclient.exe
 * (ClientCommunicationSystem::Do*). Spec with every string, chat type and
 * decomp line: docs/retail-commands/text-ui-help.md; the Help* texts are in
 * RetailHelpTexts.ts (docs/retail-commands/help-texts.md).
 *
 * Retail's file I/O (the chat log, @loadfile scripts, UI layout files) goes
 * through context methods; the integration decides the backing.
 */
import { GameActionType } from '@ac/network';
import {
  ALL_WINDOWS,
  CHAT_TYPE_COMMAND,
  CHAT_TYPE_DEFAULT,
  joinArgs,
  joinArgsAsName,
  sameWord,
  type CommandEntry,
  type CommandRun,
  type CoreCommandContext,
} from './CommandSystem';
import {
  HELP_AVAILABLE_LIST,
  HELP_MORE_INFO,
  HELP_NOTE,
  HELP_UNKNOWN_COMMAND,
  HelpType,
  SQUELCH_CHANNEL_LIST,
  convertSquelchTypesToString,
  logTextTypeFromString,
  retailHelp,
} from './RetailHelpTexts';

export interface TextUiHelpCommandContext extends CoreCommandContext {
  /**
   * CM_UI::SendNotice_ClearChatBuffer(windowId) → ChatInterface::RecvNotice_ClearChatBuffer:
   * clear the chat window with that id, or every chat window for 0.
   */
  clearChatBuffer(windowId: number): void;
  /**
   * CCommunicationSystem::s_pInstance's global SquelchInfo: the squelched
   * LogTextType ids (1 = All), or null when there is no communication system
   * (DoGlobalSquelchQuery then returns 0).
   */
  globalSquelchTypes(): ReadonlySet<number> | null;
  /** gmCCommunicationSystem::GetLastTellerName ("" when nobody has @tell'd us). */
  lastTellerName(): string;
  /**
   * CloseLogFile's file half: if a chat log is open (ClientSystem::s_pLogFile),
   * close it and return its name (m_strLogName); null when none is open.
   * Retail closes a disk file; the integration decides the backing.
   */
  closeChatLog(): string | null;
  /**
   * StartCopyOutputToFile's fopen(name, "a+") + m_strLogName = name: from now
   * on append every AddTextToScroll line whose type is not 0x1a ("%ls%ls\n",
   * timestamp prefix + text) to the named log. False when it cannot be
   * opened. Retail writes a disk file; the integration decides the backing.
   */
  openChatLog(fileName: string): boolean;
  /**
   * LoadFile's fopen(name, "rt"): the file's whole text, or null when it
   * cannot be opened. Retail reads a disk file relative to the client's
   * working directory; the integration decides the backing.
   */
  readCommandFile(fileName: string): string | null;
  /**
   * CM_UI::SendNotice_SaveUI(name) → gmGamePlayUI::SaveScreenLayout: name ""
   * is UI-Default.txt, "#auto" is UI-<World>-<Character>-<W>-<H>.txt, anything
   * else <name>.txt. Retail writes 16 "<TAG> X:%d Y: %d W: %d H: %d" lines
   * (SBOX … RADA) to disk and fails silently; the integration decides the
   * backing.
   */
  saveUiLayout(name: string): void;
  /**
   * CM_UI::SendNotice_LoadUI(name) → gmGamePlayUI::LoadScreenLayout: the same
   * file naming as {@link saveUiLayout}; resize then move each tagged element;
   * silently nothing when the layout does not exist.
   */
  loadUiLayout(name: string): void;
  /** PlayerModule::LockUI (CharacterOptions2.LockUI 0x01000000); false when there is no player system. */
  uiLocked(): boolean;
  /**
   * PlayerModule::SetLockUI(locked) WITHOUT its server event: set the
   * CharacterOptions2 bit, CM_UI::SendNotice_PlayerOptionChanged(51), then
   * UIElementManager::BroadcastGlobalMessage(0xd). DoLockUI sends
   * Event_PlayerOptionChangedEvent (SetSingleCharacterOption) itself.
   */
  setLockUI(locked: boolean): void;
}

type Run = CommandRun<TextUiHelpCommandContext>;

/** PlayerOption LockUI_PlayerOption (ACE CharacterOption.LockUI). */
const LOCK_UI_PLAYER_OPTION = 0x33;

// ── DoHelp ──

/**
 * DoHelp @ 0057f9e0 (D:370279-370479), registered for both `?` and `help`
 * (func = DoHelp, help = 0). No args: the Note line, then the "Available
 * help:" list, both type 0 to the command window. With args: only the first
 * word counts, with leading '/' and '@' trimmed; an entry with a help
 * function gets Help*(Detail) appended to "For more information, type @help
 * <command>.\n" and prints the Note line then that buffer (type 0); no entry
 * or a NULL help prints "Unknown command" (0x1a, no Note). Always true.
 */
function doHelp(run: Run, argv: string[]): boolean {
  if (argv.length < 1) {
    run.reply(HELP_NOTE, CHAT_TYPE_DEFAULT);
    run.reply(withoutWithheldLines(HELP_AVAILABLE_LIST, run.withheld), CHAT_TYPE_DEFAULT);
    return true;
  }
  const word = argv[0].replace(/^[/@]+/, '');
  const entry = run.lookup(word);
  if (entry && entry.help) {
    // The help function is passed the word as typed (after the /@ trim).
    const text = retailHelp(entry.help, HelpType.Detail, word, HELP_MORE_INFO);
    if (text === null) {
      run.reply(HELP_UNKNOWN_COMMAND, CHAT_TYPE_COMMAND);
      return true;
    }
    run.reply(HELP_NOTE, CHAT_TYPE_DEFAULT);
    run.reply(withoutWithheldLines(text, run.withheld), CHAT_TYPE_DEFAULT);
    return true;
  }
  run.reply(HELP_UNKNOWN_COMMAND, CHAT_TYPE_COMMAND);
  return true;
}

/**
 * The help text without the lines that offer a command this world's era
 * leaves out (era/EraFeatures FEATURE_COMMANDS): a line starting "@word" or
 * "@help word" whose word is withheld. Every other line, retail's run-ons and
 * repeats included, is kept as is; with nothing withheld the text is unchanged.
 */
export function withoutWithheldLines(text: string, withheld: (name: string) => boolean): string {
  return text.split('\n').filter((line) => {
    const m = /^@(?:help\s+)?([^\s,]+)/i.exec(line);
    return !m || !withheld(m[1]);
  }).join('\n');
}

// ── DoMessageTypes ──

/**
 * DoMessageTypes @ 0057a010 (D:365367-365406): arguments ignored; prints
 * GetListofSquelchChannels ("Squelch channels are as follows:\n  …\n"),
 * type 0, command window.
 */
function doMessageTypes(run: Run): boolean {
  run.reply(SQUELCH_CHANNEL_LIST, CHAT_TYPE_DEFAULT);
  return true;
}

// ── DoClear ──

/**
 * DoClear @ 0056e600 (D:356587-356605): clears the command's chat window, or
 * every window for a case-insensitive "all" first argument (other arguments
 * are ignored). Prints nothing, sends nothing.
 */
function doClear(run: Run, argv: string[]): boolean {
  const windowId = argv.length > 0 && sameWord(argv[0], 'all') ? ALL_WINDOWS : run.source;
  run.ctx.clearChatBuffer(windowId);
  return true;
}

// ── DoFilter / DoUnFilter ──

/**
 * gmCCommunicationSystem::DoGlobalSquelchQuery @ 0058a0a0 (D:379031-379153):
 * the globally filtered types ("none" when empty), printed type 0 to window
 * 0 (every window). False when there is no communication system.
 */
function doGlobalSquelchQuery(ctx: TextUiHelpCommandContext): boolean {
  const types = ctx.globalSquelchTypes();
  if (types === null) return false;
  // The global SquelchInfo carries no name / zone flag, so ConvertSQToPString
  // adds no "Name: … " / " (account) " prefix (unverified for retail; see spec §9).
  const list = types.size === 0 ? 'none' : convertSquelchTypesToString(types, true);
  ctx.print(
    'The following types of messages are currently being filtered globally:\n'
      + list
      + '\n'
      + '(For a list of filter options, type @help filter)\n',
    CHAT_TYPE_DEFAULT,
    ALL_WINDOWS,
  );
  return true;
}

/** ProcessSquelchArgs's result: null when it returned false (an unknown category). */
interface SquelchArgs {
  isAccount: boolean;
  name: string;
  type: number;
}

/**
 * ProcessSquelchArgs @ 00579c30 (D:365197-365366) with requireTarget false
 * (PerformGlobalSquelchMod's call). Walks the leading '-' words: -reply,
 * -account, else a LogTextType name (the last one wins). An unknown name
 * prints "\"-<word>\" is not a valid squelch category." (0x1a; the whole argv word) and fails.
 * With -reply the name is the last teller ("A player must @tell you…" when
 * there is none); otherwise JoinArgsAsName of the words after the dashes.
 */
function processSquelchArgs(run: Run, argv: string[]): SquelchArgs | null {
  const out: SquelchArgs = { isAccount: false, name: '', type: 1 };
  if (argv.length < 1) {
    // Unreachable from PerformGlobalSquelchMod (argc 0 is the query); kept as retail.
    run.reply('Not enough arguements.', CHAT_TYPE_COMMAND);
    return out;
  }
  let i = 0;
  let reply = false;
  for (; i < argv.length; i++) {
    const word = argv[i];
    if (word.charAt(0) !== '-') break;
    const bare = word.slice(1);
    if (sameWord(bare, 'reply')) {
      reply = true;
    } else if (sameWord(bare, 'account')) {
      out.isAccount = true;
    } else {
      const type = logTextTypeFromString(bare);
      if (type === null) {
        run.reply(`"${word}" is not a valid squelch category.`, CHAT_TYPE_COMMAND); // argv[i], dash included (disasm 579ee2)
        return null;
      }
      out.type = type;
    }
  }
  if (reply) {
    out.name = run.ctx.lastTellerName();
    if (out.name === '') {
      run.reply('A player must @tell you before you can squelch them with this command.', CHAT_TYPE_COMMAND);
    }
    return out;
  }
  out.name = joinArgsAsName(argv.slice(i));
  return out;
}

/**
 * PerformGlobalSquelchMod @ 0057c2d0 (D:367373-367435). No args: the global
 * filter listing (false only without a communication system, which makes
 * DoCommand print "That is not a valid command."). A first word without a
 * '-' prints "You must specify a valid message type prefixed by a dash.".
 * Otherwise, with no -account and no name left over,
 * Event_ModifyGlobalSquelch (0x5B: u32 add, u32 type); else "Incorrect
 * usage, use @help for proper arguements.".
 *
 * Retail quirks kept: `@filter -reply` with no last teller prints the
 * "A player must @tell you…" line AND sends ModifyGlobalSquelch for the
 * current type (1 = All when no type word was given); with a last teller it
 * prints "Incorrect usage…".
 */
function performGlobalSquelchMod(run: Run, argv: string[], add: boolean): boolean {
  if (argv.length === 0) return doGlobalSquelchQuery(run.ctx);
  if (argv[0].charAt(0) !== '-') {
    run.reply('You must specify a valid message type prefixed by a dash.', CHAT_TYPE_COMMAND);
    return true;
  }
  const args = processSquelchArgs(run, argv);
  if (args === null) return true;
  if (!args.isAccount && args.name === '') {
    run.ctx.send(GameActionType.ModifyGlobalSquelch, (w) => {
      w.writeUInt32(add ? 1 : 0);
      w.writeUInt32(args.type >>> 0);
    });
    return true;
  }
  run.reply('Incorrect usage, use @help for proper arguements.', CHAT_TYPE_COMMAND);
  return true;
}

/** DoFilter @ 0057c860 (D:367691): PerformGlobalSquelchMod(argc, argv, true). */
function doFilter(run: Run, argv: string[]): boolean {
  return performGlobalSquelchMod(run, argv, true);
}

/** DoUnFilter @ 0057c880 (D:367704): PerformGlobalSquelchMod(argc, argv, false). */
function doUnFilter(run: Run, argv: string[]): boolean {
  return performGlobalSquelchMod(run, argv, false);
}

// ── DoSetOutput (@log) ──

/**
 * CloseLogFile @ 0057acc0 (D:366250-366289): when a log is open, print
 * "Chat log <name> closed.\n" (type 0, command window), close it and return
 * true; otherwise false, silently.
 */
function closeLogFile(run: Run): boolean {
  const name = run.ctx.closeChatLog();
  if (name === null) return false;
  run.reply(`Chat log ${name} closed.\n`, CHAT_TYPE_DEFAULT);
  return true;
}

/**
 * template_find_extension @ 0040b360 (via PSUtils::get_extension): scanning
 * back from the end, a '.' before any '\\', '/' or ':' is an extension.
 * (The extension includes its '.', so "name." counts as having one.)
 */
function hasExtension(name: string): boolean {
  for (let i = name.length - 1; i >= 0; i--) {
    const c = name.charAt(i);
    if (c === '.') return true;
    if (c === '\\' || c === '/' || c === ':') return false;
  }
  return false;
}

/**
 * DoSetOutput @ 0057e4f0 (D:369165-369269). No args: close the log ("Chat
 * output now directed only to the screen.\n") or, with none open, "Please
 * specify a file to append chat messages to.\n". With args: the joined name
 * (".txt" added when it has no extension), StartCopyOutputToFile (which
 * closes any open log first, printing its "closed" line), then "Copying chat
 * to <name>.  Run command again…" or "Failed to redirect to file <name>!\n".
 * Everything type 0, command window.
 */
function doSetOutput(run: Run, argv: string[]): boolean {
  let name = joinArgs(argv);
  if (name.length === 0) {
    if (closeLogFile(run)) run.reply('Chat output now directed only to the screen.\n', CHAT_TYPE_DEFAULT);
    else run.reply('Please specify a file to append chat messages to.\n', CHAT_TYPE_DEFAULT);
    return true;
  }
  if (!hasExtension(name)) name += '.txt';
  let msg = `Copying chat to ${name}.  Run command again with no arguments to turn off logging.\n`;
  // StartCopyOutputToFile @ 0057c8a0 (D:367709-367731).
  closeLogFile(run);
  if (!run.ctx.openChatLog(name)) msg = `Failed to redirect to file ${name}!\n`;
  run.reply(msg, CHAT_TYPE_DEFAULT);
  return true;
}

// ── DoLoadFile ──

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** strftime("%Y-%m-%d-%a", localtime(t)) in the C locale. */
function loadFileDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${WEEKDAYS[d.getDay()]}`;
}

/**
 * The lines fgets(buf, 0x400, f) yields from a text-mode ("rt") file: CRLF
 * read as LF, each line at most 1023 characters (a longer one comes back in
 * pieces), the '\n' kept.
 */
function fgetsLines(text: string): string[] {
  const src = text.replace(/\r\n/g, '\n');
  const lines: string[] = [];
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const end = Math.min(nl < 0 ? src.length : nl + 1, pos + 0x3ff);
    lines.push(src.slice(pos, end));
    pos = end;
  }
  return lines;
}

/**
 * LoadFile @ 00581710 (D:371529-371589): for each fgets line,
 * MakeLoadFileVariableSubstitutions @ 00580740 (drop every '\n', replace
 * %DATE% with strftime "%Y-%m-%d-%a"), echo it (type 0, command window), then
 * run it through OnChatCommand from the same window. False when the file
 * cannot be opened.
 */
function loadFile(run: Run, fileName: string): boolean {
  const text = run.ctx.readCommandFile(fileName);
  if (text === null) return false;
  for (const raw of fgetsLines(text)) {
    let line = raw.split('\n').join('');
    if (line.includes('%DATE%')) line = line.split('%DATE%').join(loadFileDate(run.ctx.nowSeconds()));
    run.reply(line, CHAT_TYPE_DEFAULT);
    // Retail runs every line, blank ones included, with no delay; a nested @loadfile recurses.
    run.dispatch(line);
  }
  return true;
}

/**
 * DoLoadFile @ 00581870 (D:371592-371631): the joined arguments are the file
 * name. Empty → "You must provide a file name."; unreadable → "Cannot open
 * file <name>" (no newline). Both type 0x1a, command window. Always true.
 */
function doLoadFile(run: Run, argv: string[]): boolean {
  const fileName = joinArgs(argv);
  if (fileName.length === 0) {
    run.reply('You must provide a file name.', CHAT_TYPE_COMMAND);
  } else if (!loadFile(run, fileName)) {
    run.reply(`Cannot open file ${fileName}`, CHAT_TYPE_COMMAND);
  }
  return true;
}

// ── DoSaveUI / DoLoadUI / DoSaveAutoUI / DoLoadAutoUI ──

/** The 0x10-byte PStringBase length limit (strlen ≤ 15). */
const UI_FILE_NAME_MAX = 15;

/**
 * The shared shape of DoSaveUI @ 0056fff0 (D:357984-358052) and DoLoadUI @
 * 00570150 (D:358054-358122): 2+ args → the usage line; none → the default
 * layout (""); one → that name when strlen ≤ 15, else "The file name must be
 * 16 characters or less." (retail quirk: a 16-character name is rejected).
 */
function uiLayoutCommand(run: Run, argv: string[], usage: string, act: (name: string) => void): boolean {
  if (argv.length >= 2) {
    run.reply(usage, CHAT_TYPE_COMMAND);
    return true;
  }
  if (argv.length === 0) {
    act('');
    return true;
  }
  if (argv[0].length <= UI_FILE_NAME_MAX) act(argv[0]);
  else run.reply('The file name must be 16 characters or less.', CHAT_TYPE_COMMAND);
  return true;
}

/** DoSaveUI @ 0056fff0 (D:357984-358052): CM_UI::SendNotice_SaveUI. */
function doSaveUI(run: Run, argv: string[]): boolean {
  return uiLayoutCommand(run, argv, 'Please use @help saveui for proper usage.', (n) => run.ctx.saveUiLayout(n));
}

/** DoLoadUI @ 00570150 (D:358054-358122): CM_UI::SendNotice_LoadUI. */
function doLoadUI(run: Run, argv: string[]): boolean {
  return uiLayoutCommand(run, argv, 'Please use @help loadui for proper usage.', (n) => run.ctx.loadUiLayout(n));
}

/** DoSaveAutoUI @ 005702b0 (D:358124-358160): any argument → usage; else SendNotice_SaveUI("#auto"). */
function doSaveAutoUI(run: Run, argv: string[]): boolean {
  if (argv.length >= 1) run.reply('Please use @help saveautoui for proper usage.', CHAT_TYPE_COMMAND);
  else run.ctx.saveUiLayout('#auto');
  return true;
}

/** DoLoadAutoUI @ 00570330 (D:358162-358198): any argument → usage; else SendNotice_LoadUI("#auto"). */
function doLoadAutoUI(run: Run, argv: string[]): boolean {
  if (argv.length >= 1) run.reply('Please use @help loadautoui for proper usage.', CHAT_TYPE_COMMAND);
  else run.ctx.loadUiLayout('#auto');
  return true;
}

// ── DoLockUI ──

/**
 * DoLockUI @ 005703b0 (D:358200-358245): any argument → "Please use @help
 * lockui for proper usage." (0x1a). Otherwise flip PlayerModule LockUI
 * (SetLockUI @ 005d3340 → CPlayerModule::OnChanged(51) → it is an auto-save
 * option, so Event_PlayerOptionChangedEvent: SetSingleCharacterOption 0x0005,
 * u32 option 0x33, u32 value) and broadcast global message 0xd. Prints nothing.
 */
function doLockUI(run: Run, argv: string[]): boolean {
  if (argv.length >= 1) {
    run.reply('Please use @help lockui for proper usage.', CHAT_TYPE_COMMAND);
    return true;
  }
  const locked = !run.ctx.uiLocked();
  run.ctx.setLockUI(locked);
  run.ctx.send(GameActionType.SetSingleCharacterOption, (w) => {
    w.writeUInt32(LOCK_UI_PLAYER_OPTION);
    w.writeUInt32(locked ? 1 : 0);
  });
  return true;
}

/** Every text / UI / help command-table entry (InitializeCommands @ 00581970). */
export function textUiHelpCommandEntries(): CommandEntry<TextUiHelpCommandContext>[] {
  return [
    // DoHelp is the handler of both; their help pointer is NULL (initcmds.c 124-131, 155-170).
    { name: '?', handler: doHelp, help: null },
    { name: 'help', handler: doHelp, help: null },
    // Help-only group words: no handler (DoCommand falls through to DoChannelCommand / Talk).
    { name: 'commands', handler: null, help: 'HelpAllGroup' },
    { name: 'text', handler: null, help: 'HelpTextGroup' },
    { name: 'messagetypes', handler: doMessageTypes, help: 'HelpMessageTypes' },
    { name: 'message_types', handler: doMessageTypes, help: 'HelpMessageTypes' },
    { name: 'msgtypes', handler: doMessageTypes, help: 'HelpMessageTypes' },
    { name: 'msg_types', handler: doMessageTypes, help: 'HelpMessageTypes' },
    { name: 'saveui', handler: doSaveUI, help: 'HelpSaveUI' },
    { name: 'loadui', handler: doLoadUI, help: 'HelpLoadUI' },
    { name: 'saveautoui', handler: doSaveAutoUI, help: 'HelpSaveAutoUI' },
    { name: 'loadautoui', handler: doLoadAutoUI, help: 'HelpLoadAutoUI' },
    { name: 'lockui', handler: doLockUI, help: 'HelpLockUI' },
    { name: 'clear', handler: doClear, help: 'HelpClear' },
    { name: 'filter', handler: doFilter, help: 'HelpFilter' },
    { name: 'unfilter', handler: doUnFilter, help: 'HelpUnFilter' },
    { name: 'log', handler: doSetOutput, help: 'DoSetOutputHelp' },
    { name: 'loadfile', handler: doLoadFile, help: 'HelpLoadFile' },
  ];
}
