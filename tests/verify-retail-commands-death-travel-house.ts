/**
 * Retail death / travel / PK / housing chat commands (DoConsent, DoCorpse,
 * DoDie, DoLifestone, DoMarketplace, DoPermit, DoPKArena, DoPKLArena,
 * DoPKLite, DoHouse + sub-handlers) driven through the real CommandSystem.
 * Spec: docs/retail-commands/death-travel-house.md.
 */
import { describe, it, expect } from 'vitest';
import { BinaryWriter, GameActionType } from '../packages/network/src/index.js';
import {
  CommandSystem,
  type CommandEntry,
} from '../packages/renderer/src/chat/commands/CommandSystem.js';
import {
  ABANDON_DIALOG_FIRST,
  ABANDON_DIALOG_SECOND,
  DIE_DIALOG_TEXT,
  cellIdToCoordinateString,
  deathTravelHouseCommandEntries,
  type DeathTravelHouseCommandContext,
} from '../packages/renderer/src/chat/commands/DeathTravelHouseCommands.js';

interface Sent { type: number; bytes: number[] }
interface Printed { text: string; chatType: number; windowId: number }

const SOURCE = 8;
const HOUSE_HELP = 'Please see @help House for more information on how to use this command';
const NOT_VALID = 'That is not a valid command.';

function makeFake(opts: { sendOk?: boolean } = {}) {
  const sent: Sent[] = [];
  const printed: Printed[] = [];
  const dialogs: Array<{ text: string; onYes: () => void }> = [];
  const state = {
    acceptLoot: false,
    lastOutsideDeathCell: null as number | null | undefined,
    flags: 0 as number | null,
    sendOk: opts.sendOk ?? true,
  };
  const ctx: DeathTravelHouseCommandContext = {
    print: (text, chatType, windowId) => { printed.push({ text, chatType, windowId }); },
    send: (type, write) => {
      const w = new BinaryWriter();
      write?.(w);
      sent.push({ type, bytes: [...w.toBuffer()] });
      return state.sendOk;
    },
    talkFocus: () => 1,
    lastSpeakableTarget: () => 0,
    usingTurbineChat: () => false,
    turbineRoom: () => 0,
    sendTurbineChat: () => false,
    hearsAllegianceChat: () => true,
    isOlthoi: () => false,
    globalChannelName: () => '',
    chatPose: () => null,
    playPoseMotion: () => false,
    gender: () => 1,
    nowSeconds: () => 0,
    confirm: (text, onYes) => { dialogs.push({ text, onYes }); },
    acceptsLootPermits: () => state.acceptLoot,
    setAcceptLootPermits: (on) => { state.acceptLoot = on; },
    lastOutsideDeathCell: () => state.lastOutsideDeathCell,
    playerDescriptionFlags: () => state.flags,
  };
  const sys = new CommandSystem(ctx, deathTravelHouseCommandEntries());
  const run = (line: string) => sys.onChatCommand(line, SOURCE);
  return { sent, printed, dialogs, state, sys, run };
}

const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
/** String16L: u16 length, Windows-1252 bytes, zero pad to 4 (counting the length). */
function str16(s: string): number[] {
  const out = [s.length & 0xff, s.length >> 8, ...[...s].map((c) => c.charCodeAt(0))];
  while (out.length % 4 !== 0) out.push(0);
  return out;
}

const reply = (text: string, chatType = 0x1a): Printed => ({ text, chatType, windowId: SOURCE });

describe('command table', () => {
  it('registers every retail name with its Help* function', () => {
    const names = deathTravelHouseCommandEntries().map((e) => [e.name, e.handler === null ? null : 'fn', e.help]);
    expect(names).toEqual([
      ['death', null, 'HelpDeathGroup'],
      ['consent', 'fn', 'HelpConsent'],
      ['corpse', 'fn', 'HelpCorpse'], ['cor', 'fn', 'HelpCorpse'],
      ['die', 'fn', 'HelpDie'],
      ['lifestone', 'fn', 'HelpLifestone'], ['lif', 'fn', 'HelpLifestone'], ['ls', 'fn', 'HelpLifestone'],
      ['marketplace', 'fn', 'HelpMarketplace'], ['mar', 'fn', 'HelpMarketplace'], ['mp', 'fn', 'HelpMarketplace'],
      ['permit', 'fn', 'HelpPermit'],
      ['pkarena', 'fn', 'HelpPKArena'], ['pka', 'fn', 'HelpPKArena'],
      ['pklarena', 'fn', 'HelpPKLArena'], ['pla', 'fn', 'HelpPKLArena'],
      ['pklite', 'fn', 'HelpPKLite'], ['pkl', 'fn', 'HelpPKLite'],
      ['house', 'fn', 'HelpHouse'], ['hou', 'fn', 'HelpHouse'],
      ['hslist', 'fn', 'HelpHouseAvailableList'],
      ['hor', 'fn', 'HelpHouse'], ['hr', 'fn', 'HelpHouse'],
      ['hom', 'fn', 'HelpHouse'], ['hoa', 'fn', 'HelpHouse'],
    ]);
  });

  it('@death has no handler: the whole line goes to the server as Event_Talk', () => {
    const f = makeFake();
    f.run('@death');
    expect(f.sent).toEqual([{ type: GameActionType.Talk, bytes: str16('@death') }]);
    expect(f.printed).toEqual([]);
  });
});

describe('@consent (DoConsent)', () => {
  it('on: sets the option, auto-saves option 16 = 1, prints type 0 to the source window', () => {
    const f = makeFake();
    f.run('@consent ON');
    expect(f.state.acceptLoot).toBe(true);
    expect(f.sent).toEqual([{ type: GameActionType.SetSingleCharacterOption, bytes: [...u32(0x10), ...u32(1)] }]);
    expect(f.printed).toEqual([reply('You can now accept corpse looting permissions from other players.\n', 0)]);
  });

  it('on when already on: no send, the line still prints', () => {
    const f = makeFake();
    f.state.acceptLoot = true;
    f.run('/consent on');
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply('You can now accept corpse looting permissions from other players.\n', 0)]);
  });

  it('off: clears and saves 0', () => {
    const f = makeFake();
    f.state.acceptLoot = true;
    f.run('@consent off');
    expect(f.state.acceptLoot).toBe(false);
    expect(f.sent).toEqual([{ type: GameActionType.SetSingleCharacterOption, bytes: [...u32(0x10), ...u32(0)] }]);
    expect(f.printed).toEqual([reply('You are no longer accepting corpse looting permissions from other players.\n', 0)]);
  });

  it('off when already off: no send', () => {
    const f = makeFake();
    f.run('@consent off');
    expect(f.sent).toEqual([]);
    expect(f.printed).toHaveLength(1);
  });

  it('who / clear send the bare list events', () => {
    const f = makeFake();
    f.run('@consent who');
    f.run('@consent Clear');
    expect(f.sent).toEqual([
      { type: GameActionType.DisplayPlayerConsentList, bytes: [] },
      { type: GameActionType.ClearPlayerConsentList, bytes: [] },
    ]);
    expect(f.printed).toEqual([]);
  });

  it('remove <name>: JoinArgsAsName (spaces joined, leading + stripped)', () => {
    const f = makeFake();
    f.run('@consent remove +Bob  the   Mage');
    expect(f.sent).toEqual([{ type: GameActionType.RemoveFromPlayerConsentList, bytes: str16('Bob the Mage') }]);
  });

  it('remove with no name prints the 0x1a prompt', () => {
    const f = makeFake();
    f.run('@consent remove +');
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply('Please specify a person to remove from your consent list.')]);
  });

  it('a failed send returns false → "That is not a valid command." (window 0)', () => {
    const f = makeFake({ sendOk: false });
    f.run('@consent who');
    expect(f.printed).toEqual([{ text: NOT_VALID, chatType: 0x1a, windowId: 0 }]);
  });

  it.each(['@consent', '@consent bogus'])('%s: invalid subcommand', (line) => {
    const f = makeFake();
    f.run(line);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply('Please specify a valid consent command.')]);
  });
});

describe('@corpse / @cor (DoCorpse)', () => {
  it('no LastOutsideDeath position', () => {
    const f = makeFake();
    f.run('@corpse');
    expect(f.printed).toEqual([reply("We're sorry, but we have no record of your last outside corpse location.\n", 0)]);
    expect(f.sent).toEqual([]);
  });

  it('prints the cell coordinates; extra words are ignored', () => {
    const f = makeFake();
    // Holtburg-ish outdoor cell 0xA9B40019.
    f.state.lastOutsideDeathCell = 0xa9b40019;
    f.run('@cor whatever words');
    expect(f.printed).toEqual([reply(`The last time you died outside, your corpse was located at (${cellIdToCoordinateString(0xa9b40019)}).\n`, 0)]);
  });

  it('no PlayerDesc interface → false → not a valid command', () => {
    const f = makeFake();
    f.state.lastOutsideDeathCell = undefined;
    f.run('@corpse');
    expect(f.printed).toEqual([{ text: NOT_VALID, chatType: 0x1a, windowId: 0 }]);
  });

  it('CellidToCoordinateString: NS first, letters by sign, blank at zero', () => {
    // 0xA9B40019: block x=0xA9, y=0xB4, cell 0x19 → x = 0xA9*8 + 3 = 1355, y = 0xB4*8 + 0 = 1440.
    expect(cellIdToCoordinateString(0xa9b40019)).toBe('42.1N, 33.6E');
    // Block 0,0 cell 1: x = y = 0 → (-1024)*0.1 + 0.5 = -101.9.
    expect(cellIdToCoordinateString(0x00000001)).toBe('101.9S, 101.9W');
    // x = y = 1019 → exactly 0: no letter.
    // 1019 = 127*8 + 3 → block 0x7F, cell column 3 / row 3 → cell index 3*8 + 3 + 1 = 28 = 0x1C.
    expect(cellIdToCoordinateString(0x7f7f001c)).toBe('0.0, 0.0');
  });
});

describe('@die (DoDie)', () => {
  it('opens the Yes/No dialog; nothing is sent until Yes', () => {
    const f = makeFake();
    f.run('@die');
    expect(f.dialogs.map((d) => d.text)).toEqual([DIE_DIALOG_TEXT]);
    expect(DIE_DIALOG_TEXT).toBe('Do you really want to kill your character? You may drop items and accrue a vitae penalty.');
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([]);
    f.dialogs[0].onYes();
    expect(f.sent).toEqual([{ type: GameActionType.Suicide, bytes: [] }]);
  });

  it('with arguments prints the help line and opens no dialog', () => {
    const f = makeFake();
    f.run('/die now');
    expect(f.dialogs).toEqual([]);
    expect(f.printed).toEqual([reply('Please see @help die for more information on how to use this command.')]);
  });
});

describe('travel: lifestone / marketplace', () => {
  it.each(['lifestone', 'lif', 'ls'])('@%s sends TeleToLifestone', (name) => {
    const f = makeFake();
    f.run(`@${name}`);
    expect(f.sent).toEqual([{ type: GameActionType.TeleToLifestone, bytes: [] }]);
    expect(f.printed).toEqual([]);
  });

  it('@ls ignores a failed send (always true)', () => {
    const f = makeFake({ sendOk: false });
    f.run('@ls');
    expect(f.printed).toEqual([]);
  });

  it('@lifestone with args prints help', () => {
    const f = makeFake();
    f.run('@lifestone x');
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply('Please see @help lifestone for more information on how to use this command.')]);
  });

  it.each(['marketplace', 'mar', 'mp'])('@%s sends TeleToMarketPlace', (name) => {
    const f = makeFake();
    f.run(`@${name}`);
    expect(f.sent).toEqual([{ type: GameActionType.TeleToMarketPlace, bytes: [] }]);
  });

  it('@mp with args prints help', () => {
    const f = makeFake();
    f.run('@mp x');
    expect(f.printed).toEqual([reply('Please see @help marketplace for more information on how to use this command.')]);
  });

  it('a failed marketplace send is ignored', () => {
    const f = makeFake({ sendOk: false });
    f.run('@mar');
    expect(f.printed).toEqual([]);
  });
});

describe('@permit (DoPermit)', () => {
  it('add / remove send the name', () => {
    const f = makeFake();
    f.run('@permit add Some Body');
    f.run('@permit REMOVE ++Other');
    expect(f.sent).toEqual([
      { type: GameActionType.AddPlayerPermission, bytes: str16('Some Body') },
      { type: GameActionType.RemovePlayerPermission, bytes: str16('Other') },
    ]);
  });

  it.each(['@permit', '@permit grant Bob'])('%s: invalid subcommand', (line) => {
    const f = makeFake();
    f.run(line);
    expect(f.printed).toEqual([reply('Please specify a valid permit command.')]);
  });

  it('no name', () => {
    const f = makeFake();
    f.run('@permit add');
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply('Please specify a person for the permit command.')]);
  });

  it('failed send → not a valid command', () => {
    const f = makeFake({ sendOk: false });
    f.run('@permit add Bob');
    expect(f.printed).toEqual([{ text: NOT_VALID, chatType: 0x1a, windowId: 0 }]);
  });
});

describe('PK commands', () => {
  const PK = 0x20;
  const PKL = 0x2000000;

  it.each(['pkarena', 'pka'])('@%s: non-PK gets failure 0x55f (type 0, window 0)', (name) => {
    const f = makeFake();
    f.state.flags = PKL;
    f.run(`@${name}`);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([{ text: 'Only Player Killer characters may use this command!\n', chatType: 0, windowId: 0 }]);
  });

  it('@pkarena: PK sends TeleToPkArena; a missing player object skips the check', () => {
    const f = makeFake();
    f.state.flags = PK;
    f.run('@pkarena');
    f.state.flags = null;
    f.run('@pka');
    expect(f.sent).toEqual([
      { type: GameActionType.TeleToPkArena, bytes: [] },
      { type: GameActionType.TeleToPkArena, bytes: [] },
    ]);
  });

  it('@pkarena with args', () => {
    const f = makeFake();
    f.run('@pkarena now');
    expect(f.printed).toEqual([reply('Please see @help pkarena for more information on how to use this command.')]);
  });

  it.each(['pklarena', 'pla'])('@%s: non-PKL gets failure 0x560', (name) => {
    const f = makeFake();
    f.state.flags = PK;
    f.run(`@${name}`);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([{ text: 'Only Player Killer Lite characters may use this command!\n', chatType: 0, windowId: 0 }]);
  });

  it('@pklarena: PKL (or no player object) sends TeleToPklArena', () => {
    const f = makeFake();
    f.state.flags = PKL;
    f.run('@pklarena');
    f.state.flags = null;
    f.run('@pla');
    expect(f.sent).toEqual([
      { type: GameActionType.TeleToPklArena, bytes: [] },
      { type: GameActionType.TeleToPklArena, bytes: [] },
    ]);
  });

  it('@pla with args', () => {
    const f = makeFake();
    f.run('@pla x');
    expect(f.printed).toEqual([reply('Please see @help pklarena for more information on how to use this command.')]);
  });

  it.each([[PK], [PKL]])('@pklite when already PK/PKL (flags %i) gets failure 0x507', (flags) => {
    const f = makeFake();
    f.state.flags = flags;
    f.run('@pklite');
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([{
      text: 'Only Non-Player Killers may enter PK Lite. Please see @help pklite for more details about this command.\n',
      chatType: 0, windowId: 0,
    }]);
  });

  it.each(['pklite', 'pkl'])('@%s: NPK sends EnterPkLite', (name) => {
    const f = makeFake();
    f.state.flags = 0;
    f.run(`@${name}`);
    expect(f.sent).toEqual([{ type: GameActionType.EnterPkLite, bytes: [] }]);
    expect(f.printed).toEqual([]);
  });

  it('@pkl with args', () => {
    const f = makeFake();
    f.run('@pkl x');
    expect(f.printed).toEqual([reply('Please see @help pklite for more information on how to use this command.')]);
  });
});

describe('house recall shortcuts and hslist', () => {
  it.each(['hor', 'hr'])('@%s sends TeleToHouse', (name) => {
    const f = makeFake();
    f.run(`@${name}`);
    expect(f.sent).toEqual([{ type: GameActionType.TeleToHouse, bytes: [] }]);
  });

  it.each(['hom', 'hoa'])('@%s sends TeleToMansion', (name) => {
    const f = makeFake();
    f.run(`@${name}`);
    expect(f.sent).toEqual([{ type: GameActionType.TeleToMansion, bytes: [] }]);
  });

  it.each(['@hr x', '@hoa x'])('%s: extra words give the House help line (no period)', (line) => {
    const f = makeFake();
    f.run(line);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply(HOUSE_HELP)]);
  });

  it('@hr failed send → not a valid command', () => {
    const f = makeFake({ sendOk: false });
    f.run('@hr');
    expect(f.printed).toEqual([{ text: NOT_VALID, chatType: 0x1a, windowId: 0 }]);
  });

  it.each([['apartment', 4], ['Cottage', 1], ['villa', 2], ['MANSION', 3]] as const)('@hslist %s sends HouseType %i', (word, type) => {
    const f = makeFake();
    f.run(`@hslist ${word} ignored`);
    expect(f.sent).toEqual([{ type: GameActionType.ListAvailableHouses, bytes: u32(type) }]);
  });

  it.each(['@hslist', '@hslist castle'])('%s: hslist help line', (line) => {
    const f = makeFake();
    f.run(line);
    expect(f.printed).toEqual([reply('Please see @help hslist for more information on how to use this command')]);
  });
});

describe('@house (DoHouse)', () => {
  it.each(['house', 'hou'])('@%s with no subcommand prints help', (name) => {
    const f = makeFake();
    f.run(`@${name}`);
    expect(f.printed).toEqual([reply(HOUSE_HELP)]);
  });

  const simple: Array<[string, GameActionType, number[]]> = [
    ['open', GameActionType.SetOpenHouseStatus, u32(1)],
    ['OPEN', GameActionType.SetOpenHouseStatus, u32(1)],
    ['close', GameActionType.SetOpenHouseStatus, u32(0)],
    ['recall', GameActionType.TeleToHouse, []],
    ['re', GameActionType.TeleToHouse, []],
    ['mansion_recall', GameActionType.TeleToMansion, []],
    ['alleg_recall', GameActionType.TeleToMansion, []],
    ['ma', GameActionType.TeleToMansion, []],
    ['boot_all', GameActionType.BootEveryone, []],
    ['remove_all', GameActionType.BootEveryone, []],
    ['available villa', GameActionType.ListAvailableHouses, u32(2)],
    ['hooks on', GameActionType.SetHooksVisibility, u32(1)],
    ['hooks OFF', GameActionType.SetHooksVisibility, u32(0)],
    ['storage remove_all', GameActionType.RemoveAllStoragePermission, []],
    ['storage list', GameActionType.RequestFullGuestList, []],
    ['storage show', GameActionType.RequestFullGuestList, []],
    ['storage add_allegiance', GameActionType.ModifyAllegianceStoragePermission, u32(1)],
    ['storage remove_allegiance', GameActionType.ModifyAllegianceStoragePermission, u32(0)],
    ['storage add Bob Smith', GameActionType.ChangeStoragePermission, [...str16('Bob Smith'), ...u32(1)]],
    ['storage remove +Bob', GameActionType.ChangeStoragePermission, [...str16('Bob'), ...u32(0)]],
    ['storage add -ALL', GameActionType.AddAllStoragePermission, []],
    ['storage remove -all', GameActionType.RemoveAllStoragePermission, []],
    ['guest add Ann', GameActionType.AddPermanentGuest, str16('Ann')],
    ['guest remove Ann Lee', GameActionType.RemovePermanentGuest, str16('Ann Lee')],
    ['guest add -all', GameActionType.AddPermanentGuest, str16('-all')],
    ['guest remove_all', GameActionType.RemoveAllPermanentGuests, []],
    ['guest list', GameActionType.RequestFullGuestList, []],
    ['guest show', GameActionType.RequestFullGuestList, []],
    ['guest add_allegiance', GameActionType.ModifyAllegianceGuestPermission, u32(1)],
    ['guest remove_allegiance', GameActionType.ModifyAllegianceGuestPermission, u32(0)],
    ['remove Cad', GameActionType.BootSpecificHouseGuest, str16('Cad')],
    ['boot Cad Two', GameActionType.BootSpecificHouseGuest, str16('Cad Two')],
    ['boot -all', GameActionType.BootEveryone, []],
  ];

  it.each(simple)('@house %s', (args, type, bytes) => {
    const f = makeFake();
    f.run(`@house ${args}`);
    expect(f.sent).toEqual([{ type, bytes }]);
    expect(f.printed).toEqual([]);
  });

  it.each([
    '@house bogus',
    '@house hooks',
    '@house hooks maybe',
    '@house recall now',
    '@house ma now',
    '@house storage',
    '@house storage nope',
    '@house guest',
    '@house guest nope',
    '@house boot',
    '@house remove +',
  ])('%s → House help line, type 0x1a, source window', (line) => {
    const f = makeFake();
    f.run(line);
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply(HOUSE_HELP)]);
  });

  it('@house available with a bad type → hslist help', () => {
    const f = makeFake();
    f.run('@house available');
    expect(f.printed).toEqual([reply('Please see @help hslist for more information on how to use this command')]);
  });

  it('@house storage add with no name', () => {
    const f = makeFake();
    f.run('@house storage add');
    expect(f.sent).toEqual([]);
    expect(f.printed).toEqual([reply('Please specify an actual name.')]);
  });

  it('@house guest remove with no name', () => {
    const f = makeFake();
    f.run('@house guest remove');
    expect(f.printed).toEqual([reply("Please specify the guest's name.")]);
  });

  it('a failed house send → not a valid command', () => {
    const f = makeFake({ sendOk: false });
    f.run('@house open');
    expect(f.printed).toEqual([{ text: NOT_VALID, chatType: 0x1a, windowId: 0 }]);
  });

  it('abandon: two Yes/No dialogs, then AbandonHouse', () => {
    const f = makeFake();
    f.run('@house abandon extra words');
    expect(f.dialogs.map((d) => d.text)).toEqual([ABANDON_DIALOG_FIRST]);
    expect(ABANDON_DIALOG_FIRST).toBe('Do you really want to abandon your house? Any items in the house (on hooks or in storage) will stay with the house, and you will lose access to them.');
    expect(f.sent).toEqual([]);
    f.dialogs[0].onYes();
    expect(f.dialogs.map((d) => d.text)).toEqual([ABANDON_DIALOG_FIRST, ABANDON_DIALOG_SECOND]);
    expect(ABANDON_DIALOG_SECOND).toBe('Are you absolutely certain you wish to abandon your house? Click yes only if you are sure!');
    expect(f.sent).toEqual([]);
    f.dialogs[1].onYes();
    expect(f.sent).toEqual([{ type: GameActionType.AbandonHouse, bytes: [] }]);
    expect(f.printed).toEqual([]);
  });

  it('abandon answered No at the first dialog sends nothing', () => {
    const f = makeFake();
    f.run('@hou abandon');
    expect(f.dialogs).toHaveLength(1);
    expect(f.sent).toEqual([]);
  });
});

describe('entries compose into the dispatcher', () => {
  it('each entry handler is typed against the group context', () => {
    const entries: CommandEntry<DeathTravelHouseCommandContext>[] = deathTravelHouseCommandEntries();
    expect(new Set(entries.map((e) => e.name)).size).toBe(entries.length);
  });
});
