/**
 * Retail chat commands: death, travel, PK and housing — ported from the
 * decompiled EoL client (ClientCommunicationSystem::DoConsent, DoCorpse,
 * DoDie, DoLifestone, DoMarketplace, DoPermit, DoPKArena, DoPKLArena,
 * DoPKLite, DoHouse and its sub-handlers). Spec with every string, chat type
 * and decomp line: docs/retail-commands/death-travel-house.md.
 */
import { GameActionType } from '@ac/network';
import {
  ALL_WINDOWS,
  CHAT_TYPE_DEFAULT,
  joinArgsAsName,
  sameWord,
  type CommandEntry,
  type CommandRun,
  type CoreCommandContext,
} from './CommandSystem';

/** What the death / travel / house handlers need beyond the core. */
export interface DeathTravelHouseCommandContext extends CoreCommandContext {
  /**
   * DialogFactory::MakeCallbackDialogInCurrentUI with 0x8e = 1 (Yes/No) and
   * 0xc5 = text; onYes runs only when the callback reads 0x92 (answer) true.
   */
  confirm(text: string, onYes: () => void): void;
  /** PlayerModule options_ bit 0x80000 (CharacterOptions1.AcceptLootPermits). */
  acceptsLootPermits(): boolean;
  /**
   * PlayerModule::SetAcceptLootPermits' local half: set/clear bit 0x80000 and
   * CM_UI::SendNotice_PlayerOptionChanged(16). The handler sends the
   * auto-save Event_PlayerOptionChangedEvent itself.
   */
  setAcceptLootPermits(on: boolean): void;
  /**
   * PlayerDesc CBaseQualities::InqPosition(0xe) (LastOutsideDeath): the
   * objcell_id, null when there is no such position, undefined when the
   * PlayerDesc interface itself is unavailable (DoCorpse then returns false).
   */
  lastOutsideDeathCell(): number | null | undefined;
  /**
   * ClientObjMaintSystem::GetWeenieObject(player_id)'s PublicWeenieDesc
   * _bitfield (ObjectDescriptionFlag), null when the player object is not found.
   */
  playerDescriptionFlags(): number | null;
}

type Run = CommandRun<DeathTravelHouseCommandContext>;

// ── strings ──

const HOUSE_HELP = 'Please see @help House for more information on how to use this command';
const HSLIST_HELP = 'Please see @help hslist for more information on how to use this command';
export const DIE_DIALOG_TEXT = 'Do you really want to kill your character? You may drop items and accrue a vitae penalty.';
export const ABANDON_DIALOG_FIRST = 'Do you really want to abandon your house? Any items in the house (on hooks or in storage) will stay with the house, and you will lose access to them.';
export const ABANDON_DIALOG_SECOND = 'Are you absolutely certain you wish to abandon your house? Click yes only if you are sure!';

/** ObjectDescriptionFlag PlayerKiller (ACCWeenieObject::IsPK = bit 5). */
const PWD_PLAYER_KILLER = 0x20;
/** ObjectDescriptionFlag PkLiteStatus (ACCWeenieObject::IsPKLite = bit 25). */
const PWD_PK_LITE = 0x2000000;

/** PlayerOption AcceptLootPermits_PlayerOption (= ACE CharacterOption 0x10). */
const ACCEPT_LOOT_PERMITS_OPTION = 0x10;

/** HandleFailureEvent prints at type 0, window 0. */
function failureEvent(run: Run, text: string): void {
  run.ctx.print(text, CHAT_TYPE_DEFAULT, ALL_WINDOWS);
}

/** NextArg @ L357161: the first remaining word ('' when none) and the rest. */
function nextArg(argv: readonly string[]): [string, string[]] {
  return argv.length === 0 ? ['', []] : [argv[0], argv.slice(1)];
}

/** Send a GameAction with no payload. */
function sendBare(run: Run, type: GameActionType): boolean {
  return run.ctx.send(type);
}

function sendName(run: Run, type: GameActionType, name: string): boolean {
  return run.ctx.send(type, (w) => w.writeString16(name));
}

function sendU32(run: Run, type: GameActionType, value: number): boolean {
  return run.ctx.send(type, (w) => w.writeUInt32(value >>> 0));
}

// ── LandDefs::CellidToCoordinateString @ 005a9cb0 (L411170) ──

/**
 * gid_to_lcoord + "%.1f%s, %.1f%s" (NS first, then EW). Retail quirk: the
 * gid_to_lcoord result is ignored; for a non-outdoor cell retail prints
 * uninitialized stack values — this port prints the formula's result instead.
 */
export function cellIdToCoordinateString(cellId: number): string {
  const id = cellId >>> 0;
  const x = ((id >>> 21) & 0x7f8) + ((((id & 0xffff) - 1) >> 3));
  const y = (((id >>> 16) & 0xff) << 3) + ((id - 1) & 7);
  const ew = (x - 0x400) * 0.1 + 0.5;
  const ns = (y - 0x400) * 0.1 + 0.5;
  const nsLetter = ns > 0 ? 'N' : ns < 0 ? 'S' : '';
  const ewLetter = ew > 0 ? 'E' : ew < 0 ? 'W' : '';
  return `${Math.abs(ns).toFixed(1)}${nsLetter}, ${Math.abs(ew).toFixed(1)}${ewLetter}`;
}

// ── handlers ──

/** DoConsent @ 0057dda0 (L368804–368934). */
function doConsent(run: Run, argv: string[]): boolean {
  const [sub, rest] = nextArg(argv);
  if (sameWord(sub, 'on') || sameWord(sub, 'off')) {
    const on = sameWord(sub, 'on');
    // PlayerModule::SetAcceptLootPermits @ 005d2f90: only a change flips the bit,
    // and OnChanged auto-saves option 16 (IsAutoSaveOption) via Event_PlayerOptionChangedEvent.
    if (run.ctx.acceptsLootPermits() !== on) {
      run.ctx.setAcceptLootPermits(on);
      run.ctx.send(GameActionType.SetSingleCharacterOption, (w) => {
        w.writeUInt32(ACCEPT_LOOT_PERMITS_OPTION);
        w.writeUInt32(on ? 1 : 0);
      });
    }
    // The confirmation prints whether or not the value changed.
    run.reply(on
      ? 'You can now accept corpse looting permissions from other players.\n'
      : 'You are no longer accepting corpse looting permissions from other players.\n', CHAT_TYPE_DEFAULT);
    return true;
  }
  if (sameWord(sub, 'who')) return sendBare(run, GameActionType.DisplayPlayerConsentList);
  if (sameWord(sub, 'clear')) return sendBare(run, GameActionType.ClearPlayerConsentList);
  if (sameWord(sub, 'remove')) {
    const name = joinArgsAsName(rest);
    if (name) return sendName(run, GameActionType.RemoveFromPlayerConsentList, name);
    run.reply('Please specify a person to remove from your consent list.');
    return true;
  }
  run.reply('Please specify a valid consent command.');
  return true;
}

/** DoCorpse @ 00578220 (L363626–363737). Arguments are ignored entirely. */
function doCorpse(run: Run): boolean {
  const cell = run.ctx.lastOutsideDeathCell();
  // No PlayerDesc interface (or a failed QueryInterface) → false → "That is not a valid command."
  if (cell === undefined) return false;
  const text = cell === null
    ? "We're sorry, but we have no record of your last outside corpse location.\n"
    : `The last time you died outside, your corpse was located at (${cellIdToCoordinateString(cell)}).\n`;
  run.reply(text, CHAT_TYPE_DEFAULT);
  return true;
}

/** DoDie @ 00580050 (L370563–370638) + DieDialogCallback @ 0057ba70 (L366940–366985). */
function doDie(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply('Please see @help die for more information on how to use this command.');
    return true;
  }
  // Nothing is sent until the player answers Yes (CM_Character::Event_Suicide).
  run.ctx.confirm(DIE_DIALOG_TEXT, () => { run.ctx.send(GameActionType.Suicide); });
  return true;
}

/** DoLifestone @ 0056fc70 (L357801–357828). The send result is ignored. */
function doLifestone(run: Run, argv: string[]): boolean {
  if (argv.length === 0) sendBare(run, GameActionType.TeleToLifestone);
  else run.reply('Please see @help lifestone for more information on how to use this command.');
  return true;
}

/** DoMarketplace @ 0056fce0 (L357832–357858). The send result is ignored. */
function doMarketplace(run: Run, argv: string[]): boolean {
  if (argv.length === 0) sendBare(run, GameActionType.TeleToMarketPlace);
  else run.reply('Please see @help marketplace for more information on how to use this command.');
  return true;
}

/** DoPermit @ 005785a0 (L363870–363972). */
function doPermit(run: Run, argv: string[]): boolean {
  const [sub, rest] = nextArg(argv);
  const add = sameWord(sub, 'add');
  if (!add && !sameWord(sub, 'remove')) {
    run.reply('Please specify a valid permit command.');
    return true;
  }
  const name = joinArgsAsName(rest);
  if (!name) {
    run.reply('Please specify a person for the permit command.');
    return true;
  }
  return sendName(run, add ? GameActionType.AddPlayerPermission : GameActionType.RemovePlayerPermission, name);
}

/** DoPKArena @ 005788d0 (L364023–364064). */
function doPKArena(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply('Please see @help pkarena for more information on how to use this command.');
    return true;
  }
  const flags = run.ctx.playerDescriptionFlags();
  // Retail quirk: a missing player object skips the check and teleports anyway.
  if (flags !== null && (flags & PWD_PLAYER_KILLER) === 0) {
    failureEvent(run, 'Only Player Killer characters may use this command!\n'); // HandleFailureEvent(0x55f)
    return true;
  }
  sendBare(run, GameActionType.TeleToPkArena);
  return true;
}

/** DoPKLArena @ 005789d0 (L364106–364147). */
function doPKLArena(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply('Please see @help pklarena for more information on how to use this command.');
    return true;
  }
  const flags = run.ctx.playerDescriptionFlags();
  if (flags !== null && (flags & PWD_PK_LITE) === 0) {
    failureEvent(run, 'Only Player Killer Lite characters may use this command!\n'); // HandleFailureEvent(0x560)
    return true;
  }
  sendBare(run, GameActionType.TeleToPklArena);
  return true;
}

/** DoPKLite @ 0057a490 (L365684–365725). */
function doPKLite(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply('Please see @help pklite for more information on how to use this command.');
    return true;
  }
  const flags = run.ctx.playerDescriptionFlags();
  // ACCWeenieObject::IsPlayerKiller: PK or PK Lite.
  if (flags !== null && (flags & (PWD_PLAYER_KILLER | PWD_PK_LITE)) !== 0) {
    failureEvent(run, 'Only Non-Player Killers may enter PK Lite. Please see @help pklite for more details about this command.\n'); // 0x507
    return true;
  }
  sendBare(run, GameActionType.EnterPkLite);
  return true;
}

/** DoHouseRecall @ 00570450 (L358248–358272). */
function doHouseRecall(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply(HOUSE_HELP);
    return true;
  }
  return sendBare(run, GameActionType.TeleToHouse);
}

/** DoMansionRecall @ 005704b0 (L358277–358302). */
function doMansionRecall(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply(HOUSE_HELP);
    return true;
  }
  return sendBare(run, GameActionType.TeleToMansion);
}

/** HouseType per DoHouseAvailableList (ACE HouseType: Cottage 1, Villa 2, Mansion 3, Apartment 4). */
const AVAILABLE_TYPES: ReadonlyArray<readonly [string, number]> = [
  ['apartment', 4], ['cottage', 1], ['villa', 2], ['mansion', 3],
];

/** DoHouseAvailableList @ 00570510 (L358307–358381). Words past the first are ignored. */
function doHouseAvailableList(run: Run, argv: string[]): boolean {
  const [type] = nextArg(argv);
  for (const [word, houseType] of AVAILABLE_TYPES) {
    if (sameWord(type, word)) return sendU32(run, GameActionType.ListAvailableHouses, houseType);
  }
  run.reply(HSLIST_HELP);
  return true;
}

/** DoHouseStorage @ 00579560 (L364827–364975). */
function doHouseStorage(run: Run, argv: string[]): boolean {
  const [sub, rest] = nextArg(argv);
  let add: boolean;
  if (sameWord(sub, 'add')) add = true;
  else if (sameWord(sub, 'remove')) add = false;
  else if (sameWord(sub, 'remove_all')) return sendBare(run, GameActionType.RemoveAllStoragePermission);
  else if (sameWord(sub, 'list') || sameWord(sub, 'show')) return sendBare(run, GameActionType.RequestFullGuestList);
  else if (sameWord(sub, 'add_allegiance')) return sendU32(run, GameActionType.ModifyAllegianceStoragePermission, 1);
  else if (sameWord(sub, 'remove_allegiance')) return sendU32(run, GameActionType.ModifyAllegianceStoragePermission, 0);
  else {
    run.reply(HOUSE_HELP);
    return true;
  }
  const name = joinArgsAsName(rest);
  if (!name) {
    run.reply('Please specify an actual name.');
    return true;
  }
  if (sameWord(name, '-all')) {
    return sendBare(run, add ? GameActionType.AddAllStoragePermission : GameActionType.RemoveAllStoragePermission);
  }
  return run.ctx.send(GameActionType.ChangeStoragePermission, (w) => {
    w.writeString16(name);
    w.writeUInt32(add ? 1 : 0);
  });
}

/** DoHouseGuests @ 005791a0 (L364670–364810). No "-all" case here (unlike storage). */
function doHouseGuests(run: Run, argv: string[]): boolean {
  const [sub, rest] = nextArg(argv);
  let add: boolean;
  if (sameWord(sub, 'add')) add = true;
  else if (sameWord(sub, 'remove')) add = false;
  else if (sameWord(sub, 'remove_all')) return sendBare(run, GameActionType.RemoveAllPermanentGuests);
  else if (sameWord(sub, 'list') || sameWord(sub, 'show')) return sendBare(run, GameActionType.RequestFullGuestList);
  else if (sameWord(sub, 'add_allegiance')) return sendU32(run, GameActionType.ModifyAllegianceGuestPermission, 1);
  else if (sameWord(sub, 'remove_allegiance')) return sendU32(run, GameActionType.ModifyAllegianceGuestPermission, 0);
  else {
    run.reply(HOUSE_HELP);
    return true;
  }
  const name = joinArgsAsName(rest);
  if (!name) {
    run.reply("Please specify the guest's name.");
    return true;
  }
  return sendName(run, add ? GameActionType.AddPermanentGuest : GameActionType.RemovePermanentGuest, name);
}

/** DoHouseBoot @ 00579970 (L364995–365044). */
function doHouseBoot(run: Run, argv: string[]): boolean {
  const name = joinArgsAsName(argv);
  if (!name) {
    run.reply(HOUSE_HELP);
    return true;
  }
  if (sameWord(name, '-all')) return sendBare(run, GameActionType.BootEveryone);
  return sendName(run, GameActionType.BootSpecificHouseGuest, name);
}

/** DoHouse @ 00580860 (L370927–371178). NextArg consumes the subcommand; sub-handlers get the rest. */
function doHouse(run: Run, argv: string[]): boolean {
  const [sub, rest] = nextArg(argv);
  if (!sub) {
    run.reply(HOUSE_HELP);
    return true;
  }
  const is = (...words: string[]) => words.some((w) => sameWord(sub, w));
  if (is('open')) return sendU32(run, GameActionType.SetOpenHouseStatus, 1);
  if (is('close')) return sendU32(run, GameActionType.SetOpenHouseStatus, 0);
  if (is('recall', 're')) return doHouseRecall(run, rest);
  // Retail quirk: alleg_recall is compared twice; harmless.
  if (is('mansion_recall', 'alleg_recall', 'ma')) return doMansionRecall(run, rest);
  if (is('storage')) return doHouseStorage(run, rest);
  if (is('remove', 'boot')) return doHouseBoot(run, rest);
  if (is('boot_all', 'remove_all')) return sendBare(run, GameActionType.BootEveryone);
  if (is('guest')) return doHouseGuests(run, rest);
  if (is('abandon')) {
    // Remaining words are ignored. Two Yes/No dialogs (HouseAbandonDialogCallback_First @ 00580240,
    // _Second @ 0057be90) before CM_House::Event_AbandonHouse.
    run.ctx.confirm(ABANDON_DIALOG_FIRST, () => {
      run.ctx.confirm(ABANDON_DIALOG_SECOND, () => { run.ctx.send(GameActionType.AbandonHouse); });
    });
    return true;
  }
  if (is('available')) return doHouseAvailableList(run, rest);
  if (is('hooks')) {
    const [v] = nextArg(rest);
    if (sameWord(v, 'on')) return sendU32(run, GameActionType.SetHooksVisibility, 1);
    if (sameWord(v, 'off')) return sendU32(run, GameActionType.SetHooksVisibility, 0);
    // Retail quirk: any other value falls through to the generic help line.
  }
  run.reply(HOUSE_HELP);
  return true;
}

// ── table ──

/** The death / travel / PK / housing command-table entries (InitializeCommands @ 00581970). */
export function deathTravelHouseCommandEntries(): CommandEntry<DeathTravelHouseCommandContext>[] {
  const e = (
    name: string,
    handler: CommandEntry<DeathTravelHouseCommandContext>['handler'],
    help: string | null,
  ): CommandEntry<DeathTravelHouseCommandContext> => ({ name, handler, help });
  return [
    // Help-only group entry: no handler, so "@death" falls through to DoChannelCommand / Talk.
    e('death', null, 'HelpDeathGroup'),
    e('consent', doConsent, 'HelpConsent'),
    e('corpse', doCorpse, 'HelpCorpse'),
    e('cor', doCorpse, 'HelpCorpse'),
    e('die', doDie, 'HelpDie'),
    e('lifestone', doLifestone, 'HelpLifestone'),
    e('lif', doLifestone, 'HelpLifestone'),
    e('ls', doLifestone, 'HelpLifestone'),
    e('marketplace', doMarketplace, 'HelpMarketplace'),
    e('mar', doMarketplace, 'HelpMarketplace'),
    e('mp', doMarketplace, 'HelpMarketplace'),
    e('permit', doPermit, 'HelpPermit'),
    e('pkarena', doPKArena, 'HelpPKArena'),
    e('pka', doPKArena, 'HelpPKArena'),
    e('pklarena', doPKLArena, 'HelpPKLArena'),
    e('pla', doPKLArena, 'HelpPKLArena'),
    e('pklite', doPKLite, 'HelpPKLite'),
    e('pkl', doPKLite, 'HelpPKLite'),
    e('house', doHouse, 'HelpHouse'),
    e('hou', doHouse, 'HelpHouse'),
    e('hslist', doHouseAvailableList, 'HelpHouseAvailableList'),
    e('hor', doHouseRecall, 'HelpHouse'),
    e('hr', doHouseRecall, 'HelpHouse'),
    e('hom', doMansionRecall, 'HelpHouse'),
    e('hoa', doMansionRecall, 'HelpHouse'),
  ];
}
