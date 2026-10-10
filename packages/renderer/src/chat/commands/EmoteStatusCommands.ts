/**
 * Retail chat commands, emote / status group: @emote (e, em, me), @emotes,
 * @fillcomps, the "status" help group, @age, @birth, @day, @endurance,
 * @framerate, @loc, @version, @render. Ported from the decompiled EoL
 * acclient.exe (ClientCommunicationSystem::Do*). Spec with every string,
 * chat type and decomp line: docs/retail-commands/emote-status.md.
 *
 * Inline *pose* spans (ClientCommunicationSystem::Pose / PublicChat) live in
 * CommandSystem.ts; DoEmote never calls Pose.
 */
import { GameActionType } from '@ac/network';
import {
  CHAT_TYPE_COMMAND,
  CHAT_TYPE_DEFAULT,
  joinArgs,
  sameWord,
  type CommandEntry,
  type CommandRun,
  type CoreCommandContext,
} from './CommandSystem';

/** A player position as retail's Position holds it: objcell_id + Frame (cell-local origin, quaternion). */
export interface CommandPosition {
  objcellId: number;
  origin: { x: number; y: number; z: number };
  /** Frame quaternion (qw, qx, qy, qz). */
  quat: { w: number; x: number; y: number; z: number };
}

/** UIPreferences entries @render can modify. */
export type RenderPreference = 'Render_LandscapeDrawDistance' | 'Render_FieldOfView';

/**
 * AC1Legacy::Version::VerboseVersionString_ of the EoL acclient.exe
 * ("%s Portal:%s" of TurbineBuildVersion and the VERSIONINFO Comments),
 * derived from the exe's VERSIONINFO (spec section 10).
 */
export const RETAIL_VERBOSE_VERSION = '00.00.11.4186.r Portal:compiled Thu Sep  5 20:17:33 2013 : RETAIL';

export interface EmoteStatusCommandContext extends CoreCommandContext {
  /** PlayerIsPSR: PlayerDesc bool 0x2c IsAdmin, 0x2d IsArch or 0x61 IsPsr. */
  isPsr(): boolean;
  /** ACCWeenieObject::selectedID (0 = nothing selected). */
  selectedId(): number;
  /**
   * ClientObjMaintSystem::GetWeenieObject(id) then ACCWeenieObject::IsPlayer:
   * null when the client holds no weenie object for the id.
   */
  weenieIsPlayer(id: number): boolean | null;
  /** CM_UI::SendNotice_FillComponentBuyList(category, maxPrice) → gmVendorUI::FillComponentList (8 = all categories, 0 = no price cap). */
  fillComponentBuyList(category: number, maxPrice: number): void;
  /** PlayerModule::ClearDesiredCompList + CM_Magic::SendNotice_UpdateSpellComponents(2). */
  clearDesiredComponents(): void;
  /** LScape::m_fAlwaysDaylight. */
  alwaysDaylight(): boolean;
  /** LScape::SetDay(on): set always-daylight and force a sky/light recompute. */
  setDay(on: boolean): void;
  /** PlayerModule::SetPersistentAtDay(on): CharacterOptions2 bit 0x1 + OnChanged(PlayerOption 5), saved on the next periodic save. */
  setPersistentAtDay(on: boolean): void;
  /** The global fShowFramerate. */
  framerateShown(): boolean;
  /** fShowFramerate = on + CM_UI::SendNotice_SetFramerateDisplay(on) (the SmartBox FPS meter). */
  setFramerateDisplay(on: boolean): void;
  /** SmartBox::smartbox->player's m_position; null when there is no player object. */
  playerPosition(): CommandPosition | null;
  /** AC1Legacy::Version::VerboseVersionString_ (retail: {@link RETAIL_VERBOSE_VERSION}); the integration may report our own build. */
  verboseVersionString(): string;
  /** Proto_UI::SendAdminGetServerVersion: the 4-byte control message 0xF7CC (not a GameAction). */
  sendAdminGetServerVersion(): void;
  /** SmartBox::smartbox != null (DoRenderOption fails without it). */
  hasSmartBox(): boolean;
  /**
   * UIPreferences::ModifyPreference(pref, value): true when this client has
   * the preference. Retail ignores the result; the integration decides the
   * backing (our landscape radius / camera FOV settings).
   */
  modifyRenderPreference(pref: RenderPreference, value: number): boolean;
}

type Run = CommandRun<EmoteStatusCommandContext>;

// ── C runtime helpers ──

const C_SPACE = /^[ \t\n\v\f\r]*/;

/**
 * strtol(s, &end, 0) as MSVC's CRT parses it: leading whitespace, optional
 * sign, then 0x/0X hex, leading-0 octal or decimal. Returns the value
 * (clamped to LONG range), whether the whole string was consumed, and
 * whether it overflowed (errno ERANGE).
 */
export function strtol0(s: string): { value: number; consumedAll: boolean; overflow: boolean } {
  let i = (C_SPACE.exec(s)?.[0].length) ?? 0;
  let neg = false;
  if (s[i] === '+' || s[i] === '-') { neg = s[i] === '-'; i++; }
  let base = 10;
  if (s[i] === '0' && (s[i + 1] === 'x' || s[i + 1] === 'X') && /[0-9a-fA-F]/.test(s[i + 2] ?? '')) {
    base = 16; i += 2;
  } else if (s[i] === '0') {
    base = 8;
  }
  const digit = base === 16 ? /[0-9a-fA-F]/ : base === 8 ? /[0-7]/ : /[0-9]/;
  const start = i;
  let mag = 0n;
  while (i < s.length && digit.test(s[i])) { mag = mag * BigInt(base) + BigInt(parseInt(s[i], base)); i++; }
  // No digits: nothing converted, end = the start of the string.
  if (i === start) return { value: 0, consumedAll: s.length === 0, overflow: false };
  const signed = neg ? -mag : mag;
  const overflow = signed > 2147483647n || signed < -2147483648n;
  const value = overflow ? (neg ? -2147483648 : 2147483647) : Number(signed);
  return { value, consumedAll: i === s.length, overflow };
}

/** PSUtils::is_int32 @ 0056ea40: strtol(s, &end, 0) consumed the whole string with no ERANGE. */
export function isInt32(s: string): boolean {
  const r = strtol0(s);
  return r.consumedAll && !r.overflow;
}

/** atoi: leading whitespace, optional sign, decimal digits; garbage → 0 (MSVC clamps on overflow). */
export function atoi(s: string): number {
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)/.exec(s);
  if (!m) return 0;
  const v = BigInt(m[1] + m[2]);
  if (v > 2147483647n) return 2147483647;
  if (v < -2147483648n) return -2147483648;
  return Number(v);
}

/** printf "%f" of a float widened to double: 6 decimals, "-0.000000" for negative zero. */
export function cFloat(v: number): string {
  const f = Math.fround(v);
  if (Object.is(f, -0)) return '-0.000000';
  return f.toFixed(6);
}

/** printf "0x%08X". */
function hex08(v: number): string {
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

// ── DoEmote ──

/**
 * DoEmote @ 00578ad0 (decomp 364189–364223). argv is joined with single
 * spaces (JoinArgs); an empty line returns true silently. Otherwise
 * Event_Emote (0x1DF, String16L) and return the send result. No local echo:
 * the line shows when the server's HearEmote comes back.
 */
function doEmote(run: Run, argv: string[]): boolean {
  const text = joinArgs(argv);
  if (text.length === 0) return true;
  return run.ctx.send(GameActionType.Emote, (w) => w.writeString16(text));
}

// ── DoEmoteList ──

/** The literal at 0x7dc270 (trailing blank line included). */
export const EMOTE_LIST_TEXT =
  'Standard Emotes:\nNote: These commands should be bound on either side by asterisks. (Example: *wave*)\n' +
  'ShakeFist; Beckon; BeSeeingYou; BlowKiss; BowDeep; ClapHands; Cry; Laugh; Nod; Point; Shrug; Wave; Akimbo; ' +
  'HeartyLaugh; Salute; TapFoot; WaveHigh; WaveLow; Yawn; Stretch; Cringe; Kneel; Plead; Shiver; Shoo; Slouch; ' +
  'Spit; Surrender; Woah; Winded; YMCA; Eat; Drink; Teapot; Pray; Mock; Cheer; Helper; Warm Hands; Scratch Head; ' +
  'Shake Head\n\n';

/** DoEmoteList @ 0057bb30 (decomp 366989–367039): print the static list, type 0, the command's window. Args ignored. */
function doEmoteList(run: Run): boolean {
  run.reply(EMOTE_LIST_TEXT, CHAT_TYPE_DEFAULT);
  return true;
}

// ── DoFillComponents ──

/** Undef_SpellComponentCategory: every category. */
export const SPELL_COMPONENT_CATEGORY_ALL = 8;

const COMPONENT_CATEGORIES: ReadonlyArray<readonly [string, number]> = [
  ['Scarab', 0], ['Herb', 1], ['PowderedGem', 2], ['Powder', 2], ['AlchemicalSubstance', 3], ['Potion', 3],
  ['Talisman', 4], ['Taper', 5], ['Pea', 6],
  ['Scarabs', 0], ['Herbs', 1], ['PowderedGems', 2], ['Powders', 2], ['AlchemicalSubstances', 3], ['Potions', 3],
  ['Talismans', 4], ['Tapers', 5], ['Peas', 6],
];

/** MagicEnumMapper::SpellComponentCategoryFromString @ 0056e290: case-insensitive, singular or plural; null when unknown. */
export function spellComponentCategoryFromString(s: string): number | null {
  for (const [name, value] of COMPONENT_CATEGORIES) if (sameWord(s, name)) return value;
  return null;
}

/**
 * DoFillComponents @ 0056fd50 (decomp 357863–357981). Every path returns true.
 * Retail quirks kept: a third arg is never read (`@fillcomps 500 x` buys up
 * to 500); a category with a non-numeric second word fills uncapped; the
 * number is parsed by strtol base 0 (hex/octal accepted).
 */
function doFillComponents(run: Run, argv: string[]): boolean {
  const ctx = run.ctx;
  let category = SPELL_COMPONENT_CATEGORY_ALL;
  if (argv.length > 2) {
    run.reply('Please use @help fillcomps for proper usage.', CHAT_TYPE_COMMAND);
    return true;
  }
  if (argv.length === 0) {
    ctx.fillComponentBuyList(SPELL_COMPONENT_CATEGORY_ALL, 0);
    return true;
  }
  let arg = argv[0];
  if (sameWord(arg, 'clear')) {
    // CM_Character::Event_SetDesiredComponentLevel(INVALID_DID, -1): u32 wcid, i32 amount.
    // (ACE rejects wcid 0, so the server-side fill list is not cleared.)
    ctx.send(GameActionType.SetDesiredComponentLevel, (w) => { w.writeUInt32(0); w.writeInt32(-1); });
    ctx.clearDesiredComponents();
    run.reply('Component list cleared.', CHAT_TYPE_COMMAND);
    return true;
  }
  let categoryValid = false;
  const found = spellComponentCategoryFromString(arg);
  if (found !== null) {
    category = found;
    categoryValid = true;
    if (argv.length > 1) arg = argv[1];
  }
  if (isInt32(arg)) {
    const n = strtol0(arg).value;
    if (n < 1) {
      run.reply('Please specify a value greater than 0.', CHAT_TYPE_COMMAND);
      return true;
    }
    ctx.fillComponentBuyList(category, n);
  } else if (categoryValid) {
    ctx.fillComponentBuyList(category, 0);
  } else {
    run.reply('Invalid component type specified.', CHAT_TYPE_COMMAND);
  }
  return true;
}

// ── status group ──

/**
 * DoAge @ 0057c5a0 (decomp 367513–367543). A PSR with a selection asks about
 * the selected player (0 when it is not a player); a selected id the client
 * has no object for fails ("That is not a valid command."). Event_QueryAge
 * (0x1C2, u32 target); returns the send result.
 */
function doAge(run: Run): boolean {
  const ctx = run.ctx;
  let target = 0;
  if (ctx.isPsr()) {
    const sel = ctx.selectedId();
    if (sel !== 0) {
      const isPlayer = ctx.weenieIsPlayer(sel);
      if (isPlayer === null) return false;
      target = isPlayer ? sel : 0;
    }
  }
  return ctx.send(GameActionType.QueryAge, (w) => w.writeUInt32(target >>> 0));
}

/** DoBirth @ 0056e5f0 (decomp 356574–356584): Event_QueryBirth (0x1C4, u32 0); returns the send result. */
function doBirth(run: Run): boolean {
  return run.ctx.send(GameActionType.QueryBirth, (w) => w.writeUInt32(0));
}

/**
 * DoDay @ 005706f0 (decomp 358390–358429): toggle LScape always-daylight,
 * announce it (type 0x1a) and persist it as CharacterOptions2 PersistentAtDay.
 */
function doDay(run: Run): boolean {
  const ctx = run.ctx;
  const on = !ctx.alwaysDaylight();
  ctx.setDay(on);
  if (on) {
    run.reply('Let there be light!', CHAT_TYPE_COMMAND);
    ctx.setPersistentAtDay(true);
  } else {
    run.reply('Normality has been restored.', CHAT_TYPE_COMMAND);
    ctx.setPersistentAtDay(false);
  }
  return true;
}

/** The literal at 0x7de2f8 (double spaces after periods are in the binary). */
export const ENDURANCE_TEXT =
  'The endurance attribute has a number of abilities tied to it.\n' +
  "First, some combination of strength and endurance (with endurance being more important) now allows one to regenerate hit points at a faster rate the higher one's endurance is.  This bonus is in addition to any regeneration spells one may have placed upon themselves.  This endurance regeneration bonus caps at around 110%.\n" +
  "Second, the higher a player's Endurance, the less stamina one uses while attacking.  This benefit is tied to Endurance only, and it caps out at around 50% less stamina used per attack.  The minimum stamina used per attack remains one.\n" +
  "Third, the higher a player's Endurance, the more likely they are not to use a point of stamina to successfully evade a missile or melee attack.  A player is required to have Melee Defense for melee attacks or Missile Defense for missile attacks trained or specialized in order for this specific ability to work.  This benefit is tied to Endurance only, and it caps out at around a 75% chance to avoid losing a point of stamina per successful evasion.\n" +
  'Fourth, some combination of strength and endurance (the two are roughly of equivalent importance) now allows one to partially resist drain and harm attacks, up to a maximum of roughly 50%.\n' +
  'Fifth, some combination of strength and endurance (the two are roughly of equivalent importance) now allows one to have a level of "natural resistances" to the 7 damage types, the same as a certain level of life protections.  This caps out at a 50% resistance (the equivalent to level 5 life prots) to these damage types.  This resistance is not additive to life protections: higher level life protections will overwrite these natural resistances, although life vulns will take these natural resistances into account, if the player does not have a higher level life protection cast upon him.\n' +
  'The natural resistances, drain resistances, and regeneration rate info are now visible on the Character Information Panel, in what was once the Burden panel.  This panel now displays the above three Endurance benefits, the burden info, as well as information about your age, birth date, and number of deaths.\n' +
  'The 5 categories for the endurance benefits are, in order from lowest benefit to highest: Poor, Mediocre, Hardy, Resilient, and Indomitable, with each range of benefits divided up equally amongst the 5 (e.g. Poor describes having anywhere from 1-10% resistance against drain health attacks, etc.).\n';

/** DoEndurance @ 0057c5f0 (decomp 367546–367596): print the endurance text, type 0. Args ignored. */
function doEndurance(run: Run): boolean {
  run.reply(ENDURANCE_TEXT, CHAT_TYPE_DEFAULT);
  return true;
}

/** DoFrameRate @ 005707d0 (decomp 358432–358460): toggle the FPS meter; any argument is an error (still true). */
function doFrameRate(run: Run, argv: string[]): boolean {
  if (argv.length === 0) {
    run.ctx.setFramerateDisplay(!run.ctx.framerateShown());
  } else {
    run.reply('Unexpected arguments to @framerate', CHAT_TYPE_COMMAND);
  }
  return true;
}

/** Position::ToString(buf, 100) @ 005a9330: "0x%08X [%f %f %f] %f %f %f %f", _snprintf-truncated to 100 chars. */
export function positionToString(p: CommandPosition): string {
  const s = `${hex08(p.objcellId)} [${cFloat(p.origin.x)} ${cFloat(p.origin.y)} ${cFloat(p.origin.z)}] ` +
    `${cFloat(p.quat.w)} ${cFloat(p.quat.x)} ${cFloat(p.quat.y)} ${cFloat(p.quat.z)}`;
  // Retail quirk: the 100-byte buffer is zero-filled; _snprintf writes at most 100 chars.
  return s.slice(0, 100);
}

/**
 * DoLoc @ 0057a250 (decomp 365566–365648): args → "Unexpected arguments to
 * @loc"; no player → silent; cell 0 → "Not in valid cell!" (both type
 * 0x1a); else "Your location is: <Position::ToString>\n", type 0.
 */
function doLoc(run: Run, argv: string[]): boolean {
  if (argv.length !== 0) {
    run.reply('Unexpected arguments to @loc', CHAT_TYPE_COMMAND);
    return true;
  }
  const pos = run.ctx.playerPosition();
  if (!pos) return true;
  if ((pos.objcellId >>> 0) === 0) {
    run.reply('Not in valid cell!', CHAT_TYPE_COMMAND);
    return true;
  }
  run.reply(`Your location is: ${positionToString(pos)}\n`, CHAT_TYPE_DEFAULT);
  return true;
}

/**
 * DoVersion @ 0057e1b0 (decomp 368975–369040): args → "Unexpected arguments
 * to @version" (0x1a). Else "Using Turbine Chat.\n" when on, then
 * "Client version %s\n" (both type 0), and a PSR also asks the server (0xF7CC).
 */
function doVersion(run: Run, argv: string[]): boolean {
  const ctx = run.ctx;
  if (argv.length !== 0) {
    run.reply('Unexpected arguments to @version', CHAT_TYPE_COMMAND);
    return true;
  }
  if (ctx.usingTurbineChat()) run.reply('Using Turbine Chat.\n', CHAT_TYPE_DEFAULT);
  run.reply(`Client version ${ctx.verboseVersionString()}\n`, CHAT_TYPE_DEFAULT);
  if (ctx.isPsr()) ctx.sendAdminGetServerVersion();
  return true;
}

/** GraphicsOptions::HandleRenderOption's usage text. */
export const RENDER_USAGE =
  'Usage:\n@render <option> <value>\n  radius #        : set landscape radius (between 5 and 25)\n  fov #           : set field of view (between 10 and 160)\n';

/**
 * GraphicsOptions::HandleRenderOption @ 00455c30 (decomp 88724–88783).
 * Retail quirk (verified in the disassembly): it reads the option from
 * argv[1] and the value from argv[2], but DoCommand's argv[0] is already
 * the first argument, so the option is the SECOND word: `@render radius 10`
 * does nothing, `@render x radius 10` sets it. The value is compared
 * unsigned, so negatives are out of range.
 */
function handleRenderOption(ctx: EmoteStatusCommandContext, argc: number, argv: string[]): { ok: boolean; err?: string; info?: string } {
  if (argc < 2 || sameWord(argv[1], 'usage')) return { ok: false, info: RENDER_USAGE };
  if (sameWord(argv[1], 'radius')) {
    if (argc < 3) return { ok: true, err: 'Must specify a radius' };
    const v = atoi(argv[2]) >>> 0;
    if (v > 4 && v < 0x1a) {
      ctx.modifyRenderPreference('Render_LandscapeDrawDistance', v);
      return { ok: true, err: 'Landscape radius set' };
    }
    return { ok: true, err: 'Radius must be between 5 and 25' };
  }
  if (sameWord(argv[1], 'fov')) {
    if (argc < 3) return { ok: true, err: 'Must specify a field of view' };
    const v = atoi(argv[2]) >>> 0;
    if (v > 9 && v < 0xa1) {
      ctx.modifyRenderPreference('Render_FieldOfView', v);
      return { ok: true, err: 'Field of view set' };
    }
    return { ok: true, err: 'Field of view must be between 10 and 160' };
  }
  return { ok: true };
}

/**
 * DoRenderOption @ 0057e120 (decomp 368944–368972): no SmartBox → false;
 * else HandleRenderOption, print err (type 0x1a) then info (type 0), and
 * return its result (usage → false → "That is not a valid command.").
 */
function doRenderOption(run: Run, argv: string[]): boolean {
  if (!run.ctx.hasSmartBox()) return false;
  const r = handleRenderOption(run.ctx, argv.length, argv);
  if (r.err) run.reply(r.err, CHAT_TYPE_COMMAND);
  if (r.info) run.reply(r.info, CHAT_TYPE_DEFAULT);
  return r.ok;
}

/** The emote / status group's command-table entries (InitializeCommands, initcmds.c). */
export function emoteStatusCommandEntries(): CommandEntry<EmoteStatusCommandContext>[] {
  return [
    { name: 'e', handler: doEmote, help: 'HelpEmote' },
    { name: 'em', handler: doEmote, help: 'HelpEmote' },
    { name: 'emote', handler: doEmote, help: 'HelpEmote' },
    { name: 'me', handler: doEmote, help: 'HelpEmote' },
    { name: 'emotes', handler: doEmoteList, help: 'HelpEmoteList' },
    { name: 'fillcomps', handler: doFillComponents, help: 'HelpFillComponents' },
    { name: 'status', handler: null, help: 'HelpStatusGroup' },
    { name: 'age', handler: doAge, help: 'HelpAge' },
    { name: 'birth', handler: doBirth, help: 'HelpBirth' },
    { name: 'day', handler: doDay, help: 'HelpDay' },
    { name: 'endurance', handler: doEndurance, help: 'HelpEndurance' },
    { name: 'framerate', handler: doFrameRate, help: 'HelpFrameRate' },
    { name: 'loc', handler: doLoc, help: 'HelpLoc' },
    { name: 'version', handler: doVersion, help: 'HelpVersion' },
    { name: 'render', handler: doRenderOption, help: null },
  ];
}
