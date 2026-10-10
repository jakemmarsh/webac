/**
 * The exact text of every retail ClientCommunicationSystem::Help* function
 * (decompiled EoL acclient.exe), keyed by the retail function name. Each
 * string is byte-exact from acclient.exe .rdata (CP-1252, all ASCII here),
 * assembled per HelpType branch; group helps (HelpAllGroup, HelpChattingGroup,
 * HelpSquelch, …) are stored already expanded, exactly as retail renders
 * them from their nested Help* calls. Spec + VAs:
 * docs/retail-commands/help-texts.md.
 *
 * Retail quirks kept on purpose: "@say - Says some text to everyone around
 * you." has no trailing newline (so the next line runs on), HelpAllGroup
 * lists @saveui / @loadui twice and the channel lines twice, and the typos
 * ("chatyou", "send  you", "arguements", "your are") are retail's.
 *
 * Signature of every retail Help*: bool HelpX(this, HelpType, char *name,
 * PStringBase<char> *out). It APPENDS its text to *out and returns true —
 * except HelpMessageTypes (REPLACES *out via sprintf) and
 * HelpStupidChannelHack (builds its line from the name). {@link retailHelp}
 * reproduces all three shapes.
 */

import { getChannelId } from './CommandSystem';

/** HelpType (globals.tsv Summary_HelpType / List_HelpType / Detail_HelpType). */
export const enum HelpType {
  Summary = 0,
  List = 1,
  Detail = 2,
}

/** One Help* function's three branches. Retail callers only pass Summary (0) and Detail (2). */
export interface RetailHelpLevels {
  readonly summary: string;
  readonly list: string;
  readonly detail: string;
}

function h(summary: string, list: string = summary, detail: string = list): RetailHelpLevels {
  return { summary, list, detail };
}

/** Every static Help* function's text, keyed by retail function name. */
export const RETAIL_HELP_TEXTS: Readonly<Record<string, RetailHelpLevels>> = {
  DoSetOutputHelp: h(
    '@log - Commands to echo chat text to a logfile.\n',
    '@log <name> - Echoes chat text to a logfile. All the information that appears in your chat window after you type this command will be copied into a text file. Choose the file you are copying to by naming it in the command. If this file already exists, it will add the additional text to the end of it. To turn off logging, simply retype @log.\n'
      + '@log AClog.txt - Echoes chat text to a log file named Aclog.txt in your Asheron\'s Call directory. After you use this command, all the information that appears in your chat window will be written to a file in your Asheron\'s Call directory named Aclog.txt.\n'
      + '@log - If you are currently copying the text in your chat window to a logfile, this command will stop the process.\n'),
  HelpAFK: h(
    '@afk - Set your away-from-keyboard status.\n',
    '@afk - Turns on AFK (away-from-keyboard) mode. When set to AFK, other players that send you directed chatyou will receive a customizable message that your are not currently at the keyboard.\n'
      + '@afk on - Turns on AFK mode. When set to AFK, other players that send you directed chatyou will receive a customizable message that your are not currently at the keyboard.\n'
      + '@afk off - Turn off AFK mode.\n'
      + '@afk msg <message> - Set the message that will be sent to players that send you directed chat while you are in AFK mode. Issuing "@afk msg" with no message will set your AFK message back to the default. Your custom AFK message is limited to 192 characters.\n'),
  HelpAdvancedSquelch: h(
    '@squelch - Shows the current list of squelched characters.\n'
      + '@squelch [-account] <name> - Squelches all messages from a character. With the account flag, this command also stops everything except normal chat coming from the target\'s other characters.\n'
      + '@squelch [-message_type] <character> - This will filter out all text messages of a certain type  from a specific character.  For example, the following will filter out all tell messages from Oswald:\n'
      + '     Example: @squelch -tell Oswald.\n'
      + '@squelch -reply [-account] [-message_type] - This filters out all text messages from whoever last tell\'d you.  You may also use the -account flag and/or limit the squelch by indicating specific message types. For example, this will filter out all tell messages from the account of Oswald, assuming that Oswald was the last person who sent you an @tell:\n'
      + '     Example: @squelch -reply -account -tell\n'
      + '\n'),
  HelpAdvancedUnSquelch: h(
    '@unsquelch - Shows the current list of squelched characters.\n'
      + '@unsquelch <name> - Removes all squelches from a character, including account squelch.\n'
      + '@unsquelch [-message_type] <character> : This allows text messages of type message_type to come from a squelched character. For example the following allows assessment messages from a character name Oswald:\n'
      + '     Example: @unsquelch -assessment Oswald\n'
      + '@unsquelch -reply [-account] [-message_type] : This allows text messages of type message_type from whoever last sent you an @tell. For example, the following will allow any character on Oswald\'s account to once again send you @tells, assuming that Oswald was the last person who sent you an @tell:\n'
      + '     Example: @squelch -reply -account -tell\n'
      + '\n'),
  HelpAge: h(
    '@age - Displays your total gameplay time.\n'),
  HelpAllGroup: h(
    '@help commands - Lists all commands.\n',
    '@allegiance - Commands to help manage your allegiance.\n'
      + '@allegiance motd - Displays or sets the message of the day for your allegiance, see @help motd for more information.\n'
      + '@a - Sends a broadcast to your Allegiance.\n'
      + '@c - Sends a broadcast to your Co-vassals.\n'
      + '@m - Sends a broadcast to your Monarch.\n'
      + '@p - Sends a broadcast to your Patron.\n'
      + '@v - Sends a broadcast to your Vassals.\n'
      + '@f - Sends a broadcast to your Fellowship.\n'
      + '@chat - Sets whether or not you receive normal chat.\n'
      + '@notell - Sets whether or not you receive @tell\'s.\n'
      + '@reply - Sends some text to the last person who @tell\'d you.\n'
      + '@pr - Sends some text to the last person who @p\'d you.\n'
      + '@mr - Sends some text to the last person who @m\'d you.\n'
      + '@retell - Sends some text to the last person you @tell\'d.\n'
      + '@say - Says some text to everyone around you.@tell - Sends a private message to another character.\n'
      + '@a - Sends a broadcast to your Allegiance.\n'
      + '@c - Sends a broadcast to your Co-vassals.\n'
      + '@m - Sends a broadcast to your Monarch.\n'
      + '@p - Sends a broadcast to your Patron.\n'
      + '@v - Sends a broadcast to your Vassals.\n'
      + '@f - Sends a broadcast to your Fellowship.\n'
      + '@afk - Set your away-from-keyboard status.\n'
      + '@permit - Commands to give or revoke permission for others to loot your corpse.\n'
      + '@consent - Commands to help you manage the corpse-looting permissions that others give you.\n'
      + '@corpse - Displays the location of your last outdoor death.\n'
      + '@die - Kills your character and leaves a corpse, returning you to your lifestone.\n'
      + '@lifestone - Returns you to the last lifestone you used without killing you.\n'
      + '@marketplace - Teleports you to the Marketplace of Dereth.\n'
      + '@pkarena - Teleports you to the PK Arena. You must be PK to use this command.\n'
      + '@pklarena - Teleports you to the PKL Arena. You must be PKL to use this command.\n'
      + '@emote - Performs a text emote.\n'
      + '@emotes - Lists all standard emotes.\n'
      + '@fillcomps - Helps you buy components in bulk.\n'
      + '@saveui <filename> - Saves the current user interface.\n'
      + '@loadui <filename> - Loads a previously saved user interface.\n'
      + '@saveui <filename> - Saves the current user interface.\n'
      + '@loadui <filename> - Loads a previously saved user interface.\n'
      + '@lockui - Toggles the locked state of the UI layout.\n'
      + '@friends - Helps you manage your friends list.\n'
      + '@house - Commands that help you manage your house, including guest and storage management.\n'
      + '@squelch - Squelches a character or account.\n'
      + '@unsquelch - Unsquelches a squelched character or account.\n'
      + '@messagetypes - Lists all types of messages that can be squelched or filtered.\n'
      + '@age - Displays your total gameplay time.\n'
      + '@birth - Displays when your character was created.\n'
      + '@day - A toggle that lightens the outdoor landscape. Note that this command may take several seconds to take effect. \n'
      + '@endurance - Explains how endurance affects your character.\n'
      + '@framerate - Toggles the framerate display.\n'
      + '@loc - Displays your current position.\n'
      + '@pklite - Sets your status to Player Killer Lite. Type @help pklite for more details.\n'
      + '@version - Tells you what version of the software you are using.\n'
      + '@clear - Clears the chat box of all text.\n'
      + '@filter - Commands to filter out incoming messages.\n'
      + '@unfilter - Commands to remove filters from incoming messages.\n'
      + '@loadfile - Reads in the given text file and executes each line in the chat entry field.\n'
      + '@log - Commands to echo chat text to a logfile.\n'
      + '@title <new title> - Sets the title of the popup chat window.\n'),
  HelpAllegiance: h(
    '@allegiance - Commands to help manage your allegiance.\n',
    '@allegiance boot [-account] <name> - Removes a character from your allegiance.\n'
      + '@allegiance ban <add/remove> <name> - Bans all characters on the given character\'s account from your allegiance (and boots them too!)\n'
      + '@allegiance ban list - List the characters whose accounts are banned from your allegiance.\n'
      + ' WARNING! Officers banning or booting a character by account could wind up in a situation where they are no longer in the allegiance if they boot a character that is above them in the hierarchy.\n'
      + '@allegiance info <name> - Requests information on a member of your allegiance.\n'
      + '@allegiance chat <on/off> - Turn allegiance chat on and off.\n'
      + '@allegiance chat kick <name>[, <reason>] - Kick a player temporarily from the allegiance chat room.\n'
      + '@allegiance chat gag <name> - Gags a player so that they cannot see or speak in the allegiance chat room for 5 minutes.\n'
      + '@allegiance chat ungag <name> - Ungags a gagged allegiance member so that they may once again see and speak in the allegiance chat room.\n'
      + '@allegiance broadcast <message> - Broadcast a message to the entire allegiance. Limited to 10/day. Also: @ab\n'
      + '@allegiance officer <add/set> <level #> <name> - Assigns the position of officer, with the given level of permissions, to the named character.\n'
      + '@allegiance officer <remove> <name> - Removed the named character as an allegiance officer.\n'
      + '@allegiance officer clear - Clears all officer positions.\n'
      + '@allegiance officer [list] - list your allegiance officer. Can be used by anyone in an allegiance.\n'
      + '@allegiance title set <level #> <title> - Sets the title of the given officer level.\n'
      + '@allegiance title clear - Clears all officer titles.\n'
      + '@allegiance title [list] - Lists all the officer titles for your allegiance.\n'
      + '@allegiance name <set/clear> - Displays, sets, or clears the name of your allegiance.\n'
      + '@allegiance lock <on/off/toggle/check> - Locks, unlocks, or displays the locked state of your allegiance.\n'
      + '@allegiance lock bypass <clear/name> - Sets, clears, or displays a single character as an approved vassal. That character may then swear into a locked allegiance.\n'
      + '@allegiance hometown - Recalls you to your allegiance bindstone, if your allegiance has tied to one.\n'
      + '@allegiance motd - Displays or sets the message of the day for your allegiance, see @help motd for more information.\n'),
  HelpAllegiancesGroup: h(
    '@help allegiances - Commands to help you deal with your Allegiance.\n',
    '@allegiance - Commands to help manage your allegiance.\n'
      + '@allegiance motd - Displays or sets the message of the day for your allegiance, see @help motd for more information.\n'),
  HelpBirth: h(
    '@birth - Displays when your character was created.\n'),
  HelpChannelsGroup: h(
    '@help channels - How to communicate with people in your allegiance or fellowship.\n',
    '@a - Sends a broadcast to your Allegiance.\n'
      + '@c - Sends a broadcast to your Co-vassals.\n'
      + '@m - Sends a broadcast to your Monarch.\n'
      + '@p - Sends a broadcast to your Patron.\n'
      + '@v - Sends a broadcast to your Vassals.\n'
      + '@f - Sends a broadcast to your Fellowship.\n'),
  HelpChatToggle: h(
    '@chat - Sets whether or not you receive normal chat.\n',
    '@chat <on/off> - Sets whether or not you receive normal chat. When set to "off", you will no longer receive any spoken speech (normal chat).  However, you will still receive tells.\n'),
  HelpChattingGroup: h(
    '@help chatting - How to chat publically and privately.\n',
    '@chat - Sets whether or not you receive normal chat.\n'
      + '@notell - Sets whether or not you receive @tell\'s.\n'
      + '@reply - Sends some text to the last person who @tell\'d you.\n'
      + '@pr - Sends some text to the last person who @p\'d you.\n'
      + '@mr - Sends some text to the last person who @m\'d you.\n'
      + '@retell - Sends some text to the last person you @tell\'d.\n'
      + '@say - Says some text to everyone around you.@tell - Sends a private message to another character.\n'
      + '@a - Sends a broadcast to your Allegiance.\n'
      + '@c - Sends a broadcast to your Co-vassals.\n'
      + '@m - Sends a broadcast to your Monarch.\n'
      + '@p - Sends a broadcast to your Patron.\n'
      + '@v - Sends a broadcast to your Vassals.\n'
      + '@f - Sends a broadcast to your Fellowship.\n'
      + '@afk - Set your away-from-keyboard status.\n'),
  HelpClear: h(
    '@clear - Clears the chat box of all text.\n'),
  HelpConsent: h(
    '@consent - Commands to help you manage the corpse-looting permissions that others give you.\n',
    'The @consent commands allow you to display and manage your corpse-looting consent list. This list lets you control whether others may permit you to loot their corpse and also allows you to monitor who has given you permission. You may have a maximum of 20 separate permissions at any given time. You will not be able to loot a corpse that was the victim of a player killer, even if its owner has given you permission. Also, players who have squelched you are not able to permit you to loot their corpse. Note that you can toggle your consent on/off via the Character Options panel as well as through these commands.\n'
      + '@consent on - Turns on your ability to accept permissions from other players.\n'
      + '@consent off - Turns off your ability to accept permissions from other players.\n'
      + '@consent who - Lists those who have given you permission to loot their corpses.\n'
      + '@consent remove <name> - Removes the permission a player granted to you.\n'
      + '@consent clear - Clears your entire consent list.\n'
      + '\n'),
  HelpCorpse: h(
    '@corpse - Displays the location of your last outdoor death.\n',
    '@corpse - Displays the location of your last outdoor death.\n',
    '@corpse - Displays the location of your last outdoor death. Even if your corpse has disappeared or if you have subsequently died indoors, typing this command will display your last outdoor corpse location.\n'),
  HelpDay: h(
    '@day - A toggle that lightens the outdoor landscape. Note that this command may take several seconds to take effect. \n'),
  HelpDeathGroup: h(
    '@help death - Commands for making, finding, and looting corpses.\n',
    '@permit - Commands to give or revoke permission for others to loot your corpse.\n'
      + '@consent - Commands to help you manage the corpse-looting permissions that others give you.\n'
      + '@corpse - Displays the location of your last outdoor death.\n'
      + '@die - Kills your character and leaves a corpse, returning you to your lifestone.\n'
      + '@lifestone - Returns you to the last lifestone you used without killing you.\n'
      + '@marketplace - Teleports you to the Marketplace of Dereth.\n'
      + '@pkarena - Teleports you to the PK Arena. You must be PK to use this command.\n'
      + '@pklarena - Teleports you to the PKL Arena. You must be PKL to use this command.\n'),
  HelpDie: h(
    '@die - Kills your character and leaves a corpse, returning you to your lifestone.\n',
    '@die - If you wish to kill your character and leave a corpse, you may use the @die command.  This will result in your character\'s death, you will leave behind a corpse with some of your items, and you will appear at your lifestone.  If you wish to travel to your lifestone without leaving behind a corpse, you may use the @lifestone command.\n'),
  HelpEmote: h(
    '@help emote - How to perform text and action emotes.\n',
    '@emote - Performs a text emote.\n'
      + '@emotes - Lists all standard emotes.\n',
    'The @emote command causes your character to emote some text, by performing an action in the third person. For example, if you typed the following while logged in as a character named Arville:\n'
      + '    @emote looks around the town curiously.\n'
      + 'then the chat windows of everyone around you would display:\n'
      + '    Arville looks around the town curiously.\n'
      + 'You can use any of these shorter forms of the command as well:\n'
      + '         @e <text>\n'
      + '         @em <text>\n'
      + '         ; <text>\n'
      + '         : <text>\n'
      + '\n'
      + 'You can also use a variety of standard emotes. These emotes come with special animations as well as text. Type @emotes to see a list.\n'
      + '\n'),
  HelpEmoteList: h(
    'Standard Emotes:\n'
      + 'Note: These commands should be bound on either side by asterisks. (Example: *wave*)\n'
      + 'ShakeFist; Beckon; BeSeeingYou; BlowKiss; BowDeep; ClapHands; Cry; Laugh; Nod; Point; Shrug; Wave; Akimbo; HeartyLaugh; Salute; TapFoot; WaveHigh; WaveLow; Yawn; Stretch; Cringe; Kneel; Plead; Shiver; Shoo; Slouch; Spit; Surrender; Woah; Winded; YMCA; Eat; Drink; Teapot; Pray; Mock; Cheer; Helper; Warm Hands; Scratch Head; Shake Head\n'
      + '\n'),
  HelpEndurance: h(
    '@endurance - Explains how endurance affects your character.\n',
    'The endurance attribute has a number of abilities tied to it.\n'
      + 'First, some combination of strength and endurance (with endurance being more important) now allows one to regenerate hit points at a faster rate the higher one\'s endurance is.  This bonus is in addition to any regeneration spells one may have placed upon themselves.  This endurance regeneration bonus caps at around 110%.\n'
      + 'Second, the higher a player\'s Endurance, the less stamina one uses while attacking.  This benefit is tied to Endurance only, and it caps out at around 50% less stamina used per attack.  The minimum stamina used per attack remains one.\n'
      + 'Third, the higher a player\'s Endurance, the more likely they are not to use a point of stamina to successfully evade a missile or melee attack.  A player is required to have Melee Defense for melee attacks or Missile Defense for missile attacks trained or specialized in order for this specific ability to work.  This benefit is tied to Endurance only, and it caps out at around a 75% chance to avoid losing a point of stamina per successful evasion.\n'
      + 'Fourth, some combination of strength and endurance (the two are roughly of equivalent importance) now allows one to partially resist drain and harm attacks, up to a maximum of roughly 50%.\n'
      + 'Fifth, some combination of strength and endurance (the two are roughly of equivalent importance) now allows one to have a level of "natural resistances" to the 7 damage types, the same as a certain level of life protections.  This caps out at a 50% resistance (the equivalent to level 5 life prots) to these damage types.  This resistance is not additive to life protections: higher level life protections will overwrite these natural resistances, although life vulns will take these natural resistances into account, if the player does not have a higher level life protection cast upon him.\n'
      + 'The natural resistances, drain resistances, and regeneration rate info are now visible on the Character Information Panel, in what was once the Burden panel.  This panel now displays the above three Endurance benefits, the burden info, as well as information about your age, birth date, and number of deaths.\n'
      + 'The 5 categories for the endurance benefits are, in order from lowest benefit to highest: Poor, Mediocre, Hardy, Resilient, and Indomitable, with each range of benefits divided up equally amongst the 5 (e.g. Poor describes having anywhere from 1-10% resistance against drain health attacks, etc.).\n'),
  HelpFillComponents: h(
    '@help fillcomps - A command to help you buy components in bulk.\n',
    '@fillcomps - Helps you buy components in bulk.\n',
    'The @fillcomps command assists in the bulk purchase of spell components. It is the sole interface for filling the buy list, which is the column of red zeros to the right in your components panel. To designate which components you would like to buy, change the zeros to the number of each component you would like to buy. The types of components you can buy are scarabs, herbs, powders, potions, and talismans.\n'
      + '\n'
      + 'This is the proper syntax: @fillcomps <component type> <pyreal value>\n'
      + '\n'
      + '@fillcomps - Fills the buy list with all of the components that are desired.\n'
      + '@fillcomps <component type> - Fills the buy list with all of the components of the given type.\n'
      + '@fillcomps <pyreal value> - Fills the buy list with all of the components until the total price of the components exceeds the given value.\n'
      + '@fillcomps <component type> <pyreal value> - Fills the buy list with all of the components of the given type until the total price of components exceeds the given value.\n'
      + '@fillcomps clear - Sets the requested amount for all components to zero.\n'),
  HelpFilter: h(
    '@filter - Commands to filter out incoming messages.\n',
    'The @filter commands filter out all incoming messages of a certain type. Type @messagetypes to see a list of the message types that you can filter.\n'
      + '@filter - List all the filters currently in place.\n'
      + '@filter <-message_type> - Filters out all incoming messages of a specific type. For example, the following will filter out all spellcasting text: \n'
      + '     Example: @filter -spellcasting\n'
      + '@filter -all - Filters out all incoming messages of all types.\n'
      + '\n'),
  HelpFrameRate: h(
    '@framerate - Toggles the framerate display.\n'),
  HelpFriends: h(
    '@help friends - Commands to help you manage your friends list.\n',
    '@friends - Helps you manage your friends list.\n',
    'Every time someone on your friends list logs in or out, you will receive notification. In addition, you can query the online status of your friends list at any time. Your friends list can contain up to 50 characters.\n'
      + '@friends - Shows all your current friends and indicates if any of them are online.\n'
      + '@friends online - Shows your current online friends.\n'
      + '@friends add <name> - Adds a character to your friends list.\n'
      + '@friends remove <name> - Removes a character from your friends list.\n'
      + '@friends remove -all - Clears your friends list.\n'
      + '@friends old - Shows the characters who were on your old-style friends list prior to the January 2006 update, so you can move them to your new-style friends list if necessary.\n'),
  HelpHouse: h(
    '@help house - Commands that help you manage your house, including guest and storage management.\n',
    '@house - Commands that help you manage your house, including guest and storage management.\n',
    '@house abandon - Abandons your house.\n'
      + '@house boot <name> - Removes a player from your house.\n'
      + '@house boot -all - Removes everyone from your house.\n'
      + '@house guest add <name> - Adds players to your house guest list.\n'
      + '@house guest remove <name> - Removes players from your house guest list.\n'
      + '@house guest add_allegiance - Adds your allegiance to the guest list.\n'
      + '@house guest remove_allegiance - Removes your allegiance from the guest list.\n'
      + '@house guest remove_all - Removes all guests from your house guest list.\n'
      + '@house guest list - Shows the current guest list.\n'
      + '@house recall - Teleports you to your house.\n'
      + '@house storage add <name> - Gives a player permission to use your house storage.\n'
      + '@house storage remove <name> - Removes permission to use your house storage from a player.\n'
      + '@house storage add_allegiance - Grants storage permission to your allegiance.\n'
      + '@house storage remove_allegiance - Removes storage permission from your allegiance.\n'
      + '@house storage remove_all - Removes all storage permissions from guests.\n'
      + '@house open - Creates an open house.\n'
      + '@house close - Closes your house.\n'
      + '@house hooks on|off - Makes the hooks in your house visible or invisible.\n'
      + '@house mansion_recall - Teleports you to your allegiance mansion or villa.\n'
      + '@house alleg_recall - Teleports you to your allegiance mansion or villa.\n'
      + '@house available - See @hslist\n'),
  HelpHouseAvailableList: h(
    '@hslist <house type> - Lists the number and, if appropriate, positions of houses currently available for purchase. Types include: Apartment, Cottage, Villa, Mansion\n'),
  HelpJoinChat: h(
    '@join <channel tag> - Allows you to hear and speak on the given channel.\n'),
  HelpLeaveChat: h(
    '@leave <channel tag> - Prevents you from hearing or speaking on the given channel.\n'),
  HelpLifestone: h(
    '@lifestone - Returns you to the last lifestone you used without killing you.\n'),
  HelpLoadAutoUI: h(
    '@help loadautoui - Forces a previously saved layout to load for this user and resolution.\n',
    '@loadautoui - Forces a previously saved layout to load for this user and resolution.\n',
    '@loadautoui - Forces a previously saved layout to load for this user and resolution.'),
  HelpLoadFile: h(
    '@loadfile - Reads in the given text file and executes each line in the chat entry field.\n',
    'usage: @loadfile filename\n'
      + 'This command reads in the specified text file and executes every line as if you typed it in the chat entry field.  Essentially, this plays a script.\n'),
  HelpLoadUI: h(
    '@help loadui <filename> - Loads a previously saved user interface layout from disk using the provided file name.\n',
    '@loadui <filename> - Loads a previously saved user interface.\n',
    '@loadui <filename> - Loads a previously saved user interface layout from disk using the provided file name'),
  HelpLoc: h(
    '@loc - Displays your current position.\n',
    '@loc - Displays your current position in your chat window. Use this information when you wish to submit a bug report.\n'),
  HelpLockUI: h(
    '@help lockui - Toggles the locked state of the UI layout.\n',
    '@lockui - Toggles the locked state of the UI layout.\n'),
  HelpMarketplace: h(
    '@marketplace - Teleports you to the Marketplace of Dereth.\n'),
  HelpMotd: h(
    '@allegiance motd - Displays or sets the message of the day for your allegiance, see @help motd for more information.\n',
    '@allegiance motd - Displays the message of the day for your allegiance.\n'
      + '@allegiance motd set <text> - Sets the MOTD. Can only be used by monarchs.\n'
      + '@allegiance motd clear- Clears the MOTD. Can only be used by monarchs.\n'),
  HelpNoTell: h(
    '@notell - Sets whether or not you receive @tell\'s.\n',
    '@notell <on/off> - Sets whether or not you receive @tells. When set to "on", you will not receive any tells.\n'),
  HelpPKArena: h(
    '@pkarena - Teleports you to the PK Arena. You must be PK to use this command.\n'),
  HelpPKLArena: h(
    '@pklarena - Teleports you to the PKL Arena. You must be PKL to use this command.\n'),
  HelpPKLite: h(
    '@pklite - Sets your status to Player Killer Lite. Type @help pklite for more details.\n',
    '@pklite - Sets your status to Player Killer Lite (PK Lite). PK Lite characters can attack other PK Lite characters. They cannot, however, attack Player Killer (PK) characters. PK Lite characters operate under the same combat rules as PK characters, except that if you are killed  in a PK Lite battle, you will not accrue vitae and you will not drop any coins or items. Only Non-Player Killers may use this command to enter PK Lite. Dying in a PK Lite battle and logging off will restore your status to Non-Player Killer.\n'),
  HelpPermit: h(
    '@permit - Commands to give or revoke permission for others to loot your corpse.\n',
    'The @permit command gives or revokes corpse-looting permissions to other players. You can permit other players to loot any one of your corpses. You may not @permit a player again until he or she has looted your corpse. Permissions expire either after one hour or when the permitted player logs off. If you were killed by a player killer, no one can loot your corpse except you or your killer, even if you give someone else permission.\n'
      + '@permit add <name> - Allows  another player to loot your corpse.\n'
      + '@permit remove <name> - Removes permission to access your corpse from the named character.\n'
      + 'Type @help consent for more details on corpse looting.\n'),
  HelpReTell: h(
    '@retell - Sends some text to the last person you @tell\'d.\n',
    '@retell <text> - Sends the text to the last person you @tell\'d. You may also use @rt.\n'),
  HelpReply: h(
    '@reply - Sends some text to the last person who @tell\'d you.\n'
      + '@pr - Sends some text to the last person who @p\'d you.\n'
      + '@mr - Sends some text to the last person who @m\'d you.\n',
    '@reply <text> - Sends the text to the last person who @tell\'d you. You may also use @r or @rp.\n'
      + '@pr <text> - Sends the text to the last vassal who used @p to send  you a message.\n'
      + '@mr <text> - Sends the text to the last person who used @m to send  you a message. This only works for monarchs.\n'),
  HelpSaveAutoUI: h(
    '@help saveautoui - Saves the current user interface layout to disk for use by this character at a specific resolution. This layout will be loaded for this character when the resolution changes to this specific size.\n',
    '@saveautoui - Saves the current user interface to be loaded for specific character and resolution.\n',
    '@saveautoui - Stores the current layout to a character and resolution specific file. This layout will automatically be used when the resolution changes for this character to the current size.\n'),
  HelpSaveUI: h(
    '@help saveui <filename> - Saves the current user interface layout to disk. If a file name is provided the layout will be saved using provided file name.\n',
    '@saveui <filename> - Saves the current user interface.\n',
    '@saveui <filename> - Saves the current user interface layout to disk using the provided file name. If no file name is provided the layout is saved with a name that is unique for your server, character and resolution.\n'),
  HelpSay: h(
    '@say - Says some text to everyone around you.',
    '@say <text> - Says the text to the all the people around you. This is useful when your normal default chat is set to some other channel -- for instance, when you have selected Talk to Fellows as your default.\n'
      + 'Also: @s\n'),
  HelpSpeaker: h(
    '@speaker - No longer used, see @allegiance officer for a similar command.\n'),
  HelpSquelch: h(
    '@help squelch - Commands that let you block out messages from other players.\n',
    '@squelch - Squelches a character or account.\n'
      + '@unsquelch - Unsquelches a squelched character or account.\n'
      + '@messagetypes - Lists all types of messages that can be squelched or filtered.\n',
    'The @squelch commands let you block out messages from specific characters or players. The @unsquelch commands lets squelched messages reach you again. Use the options on these commands to squelch all message types or just some types of messages; one character or an entire account. You may have up to 32 players squelched at once. Note that NPCs cannot be permanently squelched.\n'
      + '\n'
      + '@squelch - Shows the current list of squelched characters.\n'
      + '@squelch [-account] <name> - Squelches all messages from a character. With the account flag, this command also stops everything except normal chat coming from the target\'s other characters.\n'
      + '@squelch [-message_type] <character> - This will filter out all text messages of a certain type  from a specific character.  For example, the following will filter out all tell messages from Oswald:\n'
      + '     Example: @squelch -tell Oswald.\n'
      + '@squelch -reply [-account] [-message_type] - This filters out all text messages from whoever last tell\'d you.  You may also use the -account flag and/or limit the squelch by indicating specific message types. For example, this will filter out all tell messages from the account of Oswald, assuming that Oswald was the last person who sent you an @tell:\n'
      + '     Example: @squelch -reply -account -tell\n'
      + '\n'
      + '@unsquelch - Shows the current list of squelched characters.\n'
      + '@unsquelch <name> - Removes all squelches from a character, including account squelch.\n'
      + '@unsquelch [-message_type] <character> : This allows text messages of type message_type to come from a squelched character. For example the following allows assessment messages from a character name Oswald:\n'
      + '     Example: @unsquelch -assessment Oswald\n'
      + '@unsquelch -reply [-account] [-message_type] : This allows text messages of type message_type from whoever last sent you an @tell. For example, the following will allow any character on Oswald\'s account to once again send you @tells, assuming that Oswald was the last person who sent you an @tell:\n'
      + '     Example: @squelch -reply -account -tell\n'
      + '\n'
      + 'Type @messagetypes for a complete list of message types.\n'),
  HelpStatusGroup: h(
    '@help status - Commands that display useful information.\n',
    '@age - Displays your total gameplay time.\n'
      + '@birth - Displays when your character was created.\n'
      + '@day - A toggle that lightens the outdoor landscape. Note that this command may take several seconds to take effect. \n'
      + '@endurance - Explains how endurance affects your character.\n'
      + '@framerate - Toggles the framerate display.\n'
      + '@loc - Displays your current position.\n'
      + '@pklite - Sets your status to Player Killer Lite. Type @help pklite for more details.\n'
      + '@version - Tells you what version of the software you are using.\n'),
  HelpTell: h(
    '@tell - Sends a private message to another character.\n',
    '@tell <name>, <text>  - Sends a long-distance, private message to the specified character. Note that you must put a comma after the character\'s name.\n'
      + 'Also: @t, @send, @whisper, @w\n'),
  HelpTextGroup: h(
    '@help text - Commands that help you manage your text window.\n',
    '@clear - Clears the chat box of all text.\n'
      + '@filter - Commands to filter out incoming messages.\n'
      + '@unfilter - Commands to remove filters from incoming messages.\n'
      + '@loadfile - Reads in the given text file and executes each line in the chat entry field.\n'
      + '@log - Commands to echo chat text to a logfile.\n'
      + '@title <new title> - Sets the title of the popup chat window.\n'),
  HelpTitle: h(
    '@title <new title> - Sets the title of the popup chat window.\n'),
  HelpTurbineChat_Allegiance: h(
    '@a - Sends a message to your Allegiance. Also: @guild, @gu\n'),
  HelpTurbineChat_General: h(
    '@general - Sends a message to the global General chat channel. Also: @cg\n'),
  HelpTurbineChat_LFG: h(
    '@lfg - Sends a message to the global Looking For Group (LFG) chat channel. Also: @clfg\n'),
  HelpTurbineChat_Olthoi: h(
    '@olthoi - If you are an Olthoi, sends a message to the global Olthoi chat channel. Also: @o\n'),
  HelpTurbineChat_Roleplay: h(
    '@roleplay - Sends a message to the global Roleplay chat channel. Also: @crp\n'),
  HelpTurbineChat_Society: h(
    '@society - Sends a message to the your Society chat channel. Also: @soc\n'),
  HelpTurbineChat_Trade: h(
    '@trade - Sends a message to the global Trade chat channel. Also: @ct\n'),
  HelpUnFilter: h(
    '@unfilter - Commands to remove filters from incoming messages.\n',
    'The @unfilter commands remove specific filters from your incoming messages. For a complete list of message types that you can filter, type @help messagetypes.\n'
      + '@unfilter <-message_type> - Removes filters on incoming messages of a specific type.  For example, the following allows spellcasting text to resume:\n'
      + '     Example: @unfilter -spellcasting\n'
      + '@unfilter -all - Removes all filters on incoming messages of all types.\n'),
  HelpVersion: h(
    '@version - Tells you what version of the software you are using.\n'),
};

// ── LogTextTypeEnumMapper (the squelch / filter message types) ──

/**
 * LogTextTypeEnumMapper::LogTextTypeFromString @ D:647676: the accepted
 * names (case-insensitive) and their ids. "Appraisal" and "Assessment" both
 * map to 0x10.
 */
export const LOG_TEXT_TYPE_FROM_STRING: ReadonlyArray<readonly [string, number]> = [
  ['Default', 0x00], ['Speech', 0x02], ['Tell', 0x03], ['Speech_Direct_Send', 0x04],
  ['World_Broadcast', 0x14], ['System', 0x05], ['Combat', 0x06], ['Combat_Enemy', 0x15],
  ['Combat_Self', 0x16], ['Magic', 0x07], ['Channel', 0x08], ['Channel_Send', 0x09],
  ['Social', 0x0a], ['Social_Send', 0x0b], ['Emote', 0x0c], ['Advancement', 0x0d],
  ['Abuse', 0x0e], ['Help', 0x0f], ['All', 0x01], ['Spellcasting', 0x11],
  ['Appraisal', 0x10], ['Assessment', 0x10], ['Allegiance', 0x12], ['Fellowship', 0x13],
  ['Recall', 0x17], ['Craft', 0x18], ['Salvaging', 0x19], ['Admin_Tell', 0x1f],
];

/** LogTextTypeFromString: the id for a name (case-insensitive), or null (retail returns 0). */
export function logTextTypeFromString(name: string): number | null {
  const n = name.toLowerCase();
  for (const [s, id] of LOG_TEXT_TYPE_FROM_STRING) if (s.toLowerCase() === n) return id;
  return null;
}

/**
 * LogTextTypeEnumMapper::IsLegalChannel (D:647384-647408) with
 * LogTextTypeToString's names for those ids, in id order — the only types
 * ConvertSQToPString ever names.
 */
export const LEGAL_SQUELCH_CHANNELS: ReadonlyArray<readonly [number, string]> = [
  [0x02, 'Speech'], [0x03, 'Tell'], [0x06, 'Combat'], [0x07, 'Magic'], [0x0c, 'Emote'],
  [0x10, 'Appraisal'], [0x11, 'Spellcasting'], [0x12, 'Allegiance'], [0x13, 'Fellowship'],
  [0x15, 'Combat_Enemy'], [0x16, 'Combat_Self'], [0x17, 'Recall'], [0x18, 'Craft'], [0x19, 'Salvaging'],
];

/** The SquelchInfo message-type id for "All". */
export const LOG_TEXT_TYPE_ALL = 0x01;

/**
 * gmCCommunicationSystem::ConvertSQToPString @ 00589a80 for a SquelchInfo
 * with no name and no zone flag: "" when empty; with `allShortcut`
 * (param_3 == 0) and the All bit set, "All message types"; otherwise the
 * legal channels that are squelched, ", "-separated, in id order.
 */
export function convertSquelchTypesToString(types: ReadonlySet<number>, allShortcut: boolean): string {
  if (types.size === 0) return '';
  if (allShortcut && types.has(LOG_TEXT_TYPE_ALL)) return 'All message types';
  return LEGAL_SQUELCH_CHANNELS.filter(([id]) => types.has(id)).map(([, s]) => s).join(', ');
}

/**
 * gmCCommunicationSystem::GetListofSquelchChannels @ D:378949: sprintf
 * "Squelch channels are as follows:\n  %s\n" over SquelchInfo("", 1) (every
 * bit set) converted without the "All" short-cut.
 */
export const SQUELCH_CHANNEL_LIST =
  `Squelch channels are as follows:\n  ${LEGAL_SQUELCH_CHANNELS.map(([, s]) => s).join(', ')}\n`;

// ── ChannelSystem::GetChannelName @ 005cfd80 ──

const CHANNEL_NAMES: ReadonlyMap<number, string> = new Map([
  [0x00000001, 'Abuse'], [0x00000002, 'Admin'], [0x00000004, 'Audit'], [0x00000008, 'Advocate 1'],
  [0x00000010, 'Advocate 2'], [0x00000020, 'Advocate 3'], [0x00000200, 'Sentinel'], [0x00000400, 'Help'],
  [0x00000800, 'Fellowship'], [0x00001000, 'Vassals'], [0x00002000, 'Patron'], [0x00004000, 'Monarch'],
  [0x01000000, 'Co-vassals'], [0x02000000, 'Allegiance'], [0x04000000, 'FellowBroadcast'],
  [0x08000000, 'Celestial Hand'], [0x10000000, 'Eldrytch Web'], [0x20000000, 'Radiant Blood'],
  [0x40000000, 'Olthoi'],
]);

/** ChannelSystem::GetChannelName: the channel's display name, "" when the id has none (retail leaves the string empty). */
export function getChannelName(id: number): string {
  return CHANNEL_NAMES.get(id >>> 0) ?? '';
}

// ── DoHelp's fixed strings (VAs from docs/retail-commands/text-ui-help.md §2) ──

/** DoHelp line 1 (0x7e11e0), printed before every successful @help. */
export const HELP_NOTE = '\nNote: You may substitute a forward slash (/) for the at symbol (@).\n\n';
/** DoHelp's @help <command> buffer start (0x7e1178); the Detail text is appended to it. */
export const HELP_MORE_INFO = 'For more information, type @help <command>.\n';
/** DoHelp's failure line (0x7e1154, UTF-16, no newline), type 0x1a. */
export const HELP_UNKNOWN_COMMAND = 'Unknown command';

/**
 * DoHelp's no-argument list (D:370301-370394): "Available help:\n", four
 * literal group lines, HelpEmote(Summary), three more literals, then
 * HelpSquelch / HelpStatusGroup / HelpTextGroup / HelpAllGroup (Summary).
 */
export const HELP_AVAILABLE_LIST: string =
  'Available help:\n'
  + '@help allegiances - Commands to help you deal with your Allegiance.\n'
  + '@help channels - How to communicate with people in your allegiance or fellowship.\n'
  + '@help chatting - How to chat publically and privately.\n'
  + '@help death - Commands for making, finding, and looting corpses.\n'
  + RETAIL_HELP_TEXTS.HelpEmote.summary
  + '@help fillcomps - A command to help you buy components in bulk.\n'
  + '@help friends - Commands to help you manage your friends list.\n'
  + '@help house - Commands that help you manage your house, including guest and storage management.\n'
  + RETAIL_HELP_TEXTS.HelpSquelch.summary
  + RETAIL_HELP_TEXTS.HelpStatusGroup.summary
  + RETAIL_HELP_TEXTS.HelpTextGroup.summary
  + RETAIL_HELP_TEXTS.HelpAllGroup.summary;

/**
 * Call a retail Help* function by name: `out` is the buffer it appends to,
 * the result is the buffer afterwards. Returns null for a name that is no
 * retail Help* function (DoHelp then prints "Unknown command").
 *
 *  - HelpMessageTypes @ 0056e5d0 REPLACES the buffer with
 *    GetListofSquelchChannels (retail quirk: `@help messagetypes` loses the
 *    "For more information…" prefix).
 *  - HelpStupidChannelHack @ 0056f290 appends
 *    "@" + name + " - Sends a broadcast to your " + GetChannelName(GetChannelID(name)) + ".\n"
 *    for every HelpType.
 */
export function retailHelp(
  fn: string,
  type: HelpType,
  name: string,
  out: string,
): string | null {
  if (fn === 'HelpMessageTypes') return SQUELCH_CHANNEL_LIST;
  if (fn === 'HelpStupidChannelHack') {
    return `${out}@${name} - Sends a broadcast to your ${getChannelName(getChannelId(name))}.\n`;
  }
  const levels = Object.prototype.hasOwnProperty.call(RETAIL_HELP_TEXTS, fn) ? RETAIL_HELP_TEXTS[fn] : undefined;
  if (!levels) return null;
  const text = type === HelpType.Summary ? levels.summary : type === HelpType.List ? levels.list : levels.detail;
  return out + text;
}
