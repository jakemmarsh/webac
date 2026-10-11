/**
 * VirindiTank's options (its Advanced Options list and `/vt opt`), by the
 * names VTank stores them under, with their types and defaults
 * (docs/vtank-macro-behavior.md §10). A routine profile's `settings` use
 * these names.
 *
 * Units: VTank stores a range as yards / 240 (an AC map unit is 240 yards;
 * its "yard" is a game metre). Our settings keep ranges in metres, so a
 * `range` option is converted where VTank's own numbers come in or go out:
 * an imported `/vt opt set`, Set VT Option, vtgetsetting / vtsetsetting.
 *
 * Names are case-insensitive, as in VTank ("/vt opt set enablecombat true"
 * in the wiki's own example meta); the wiki's misspellings are aliases.
 *
 * Defaults: the wiki gives none. They come from a VTank-written default
 * settings file (defaultsettings.usd, VTank's output data, not code); see the
 * provenance note in docs/vtank-macro-behavior.md.
 *
 * `engine: true` marks the options the routine engine acts on. Only those are
 * offered in the VirindiTank window (no dead-end controls); the rest are kept
 * so imported settings and expressions keep their values.
 */

export type VtOptionKind = 'bool' | 'int' | 'float' | 'range' | 'string' | 'enum';
export type VtGroup = 'Misc' | 'Recharge' | 'Melee Combat' | 'Spell Combat' | 'Ranges' | 'Navigation' | 'Buffing' | 'Crafting' | 'Looting';

export interface VtOption {
  name: string;
  kind: VtOptionKind;
  /** The default, in our units (ranges in metres). */
  default: string | number | boolean;
  group: VtGroup;
  /** The label on VTank's tabs, when it has one there. */
  label?: string;
  /** One line from VTank's own description (the wiki's Advanced Options page). */
  help?: string;
  /** For enums: value → its name. */
  values?: Record<number, string>;
  aliases?: string[];
  /** The routine engine acts on it. */
  engine?: boolean;
}

const o = (name: string, kind: VtOptionKind, def: string | number | boolean, group: VtGroup, extra: Partial<VtOption> = {}): VtOption => ({ name, kind, default: def, group, ...extra });
/** A range default given as VTank stores it (map units). */
const yd = (mapUnits: number): number => Math.round(mapUnits * 240 * 1000) / 1000;

export const VT_OPTIONS: VtOption[] = [
  // Misc
  // VTank's default is off; ours is on: our profiles are rule-first, and saved routines predate the setting.
  o('EnableMeta', 'bool', true, 'Misc', { label: 'Enable Meta', help: 'Enables meta', engine: true }),
  o('AutoCram', 'bool', false, 'Misc', { label: 'Enable Autocram', help: 'Moves items from the main pack to side packs', engine: true }),
  o('AutoStack', 'bool', true, 'Misc', { label: 'Enable Autostack', help: 'Stacks items towards the bottom-most item in the pack, and into side packs', engine: true }),
  o('RandomHelperBuffs', 'bool', false, 'Misc', { help: 'Now and then casts a random protection or regeneration spell on a player near you', engine: true }),
  o('RandomHelperIntervalSeconds', 'float', 5, 'Misc', { engine: true }),
  o('IdlePeaceMode', 'bool', false, 'Misc', { label: 'Peace Mode When Idle', help: 'Loots, navigates, and salvages in peace mode', engine: true }),
  o('StopMacroOnDeath', 'bool', true, 'Misc', { help: 'Causes the macro to become disabled when the character dies', engine: true }),
  o('RefillWornMana', 'bool', true, 'Misc', { help: 'Uses mana charge types specified in the Consumables panel to refill worn items', engine: true }),
  o('RefillWornMana-Item-ManaPercent', 'int', 33, 'Misc', { engine: true }),
  o('ManaStoneLootCount', 'int', 4, 'Misc', { help: 'How many of the Consumables tab\'s mana stones looting keeps', engine: true }),
  o('ManaTankMinimumMana', 'int', 1000, 'Misc', { help: 'Least mana an item must hold to be looted and drained into an empty stone', engine: true }),
  o('ManaChargesWhenOff', 'bool', true, 'Misc', { label: 'M. Charges When Off', engine: true }),
  o('AutoFellowManagement', 'bool', true, 'Misc', { label: 'Auto Fellow Mgmt.', engine: true }),
  o('DeleteGhostMonsters', 'bool', true, 'Misc', { help: 'Sets aside a monster that never answers spells (a ghost the server has dropped)', engine: true }),
  o('GhostMonsterSpellAttemptCount', 'int', 200, 'Misc', { engine: true }),
  o('WhoYouGonnaCall', 'bool', true, 'Misc'),
  o('BlacklistMonsterAttemptCount', 'int', 4, 'Misc', { help: 'Attempts in a row that don\'t reach a monster before it is ignored for a while', engine: true }),
  o('BlacklistMonsterTimeoutSeconds', 'int', 120, 'Misc', { engine: true }),
  o('DeleteGhostMonstersByHPTracker', 'bool', true, 'Misc', { aliases: ['DeleteGhostMonsterByHPTracker'], help: 'Sets aside a monster whose health doesn\'t change while you fight it', engine: true }),
  o('GhostDeleteHPTrackerSeconds', 'int', 30, 'Misc', { engine: true }),
  o('GoToPeaceModeToUseKits', 'bool', false, 'Misc', { engine: true }),
  o('DropToPeaceModeRetryCount', 'int', 34, 'Misc', { help: 'Failed tries to drop to peace mode before the macro wields a wand to clear a stuck combat state', engine: true }),
  o('BlacklistCorpseOpenAttemptCount', 'int', 30, 'Misc', { help: 'Failed opens before a corpse is skipped', engine: true }),
  o('BlacklistCorpseOpenTimeoutSeconds', 'int', 200, 'Misc', { help: 'How long a skipped corpse is left alone', engine: true }),
  // Recharge
  o('Recharge-Norm-HitP', 'int', 75, 'Recharge', { label: 'Heal at:', engine: true }),
  o('Recharge-Norm-Stam', 'int', 50, 'Recharge', { label: 'Restam at:', engine: true }),
  o('Recharge-Norm-Mana', 'int', 50, 'Recharge', { label: 'Get Mana at:', engine: true }),
  o('Recharge-NoTarg-HitP', 'int', 1, 'Recharge', { label: 'Top-off HP:', engine: true }),
  o('Recharge-NoTarg-Stam', 'int', 1, 'Recharge', { label: 'Top-off Stam:', engine: true }),
  o('Recharge-NoTarg-Mana', 'int', 1, 'Recharge', { label: 'Top-off Mana:', engine: true }),
  o('Recharge-Helper-HitP', 'int', 20, 'Recharge', { label: 'Heal others at:', engine: true }),
  o('Recharge-Helper-Stam', 'int', 1, 'Recharge', { label: 'Restam others', engine: true }),
  o('Recharge-Helper-Mana', 'int', 1, 'Recharge', { label: 'Infuse others', engine: true }),
  o('DoHelp', 'bool', true, 'Recharge', { engine: true }),
  o('HelperDistanceHitP', 'range', yd(0.310416666666667), 'Recharge', { engine: true }),
  o('HelperDistanceStam', 'range', yd(0.310416666666667), 'Recharge', { engine: true }),
  o('HelperDistanceMana', 'range', yd(0.166666666666667), 'Recharge', { engine: true }),
  o('CastDispelSelf', 'bool', false, 'Recharge', { label: 'Cast Dispel Self', engine: true }),
  o('UseDispelItems', 'bool', false, 'Recharge', { label: 'Use Dispel Items', engine: true }),
  o('UseDispelDrum', 'bool', false, 'Recharge'),
  o('UseHealersHeart', 'bool', true, 'Recharge', { engine: true }),
  o('JumpOutWandCasting', 'bool', false, 'Recharge', { engine: true }),
  o('RechargeBoostTimeSeconds', 'float', 5, 'Recharge', { help: 'Maximum time for the recharge boost effect to last. Boost causes the macro to prefer to recharge once it switches to magic mode to recharge', engine: true }),
  o('RechargeBoostAmount', 'int', 40, 'Recharge', { help: 'Number of h/s/m points used for recharge boost', engine: true }),
  o('MinimumHealKitSuccessChance', 'int', 95, 'Recharge', { engine: true }),
  o('UseKitsInMagicMode', 'bool', true, 'Recharge', { engine: true }),
  o('StaminaToHealthMultiplier', 'float', 1.9, 'Recharge', { engine: true }),
  o('ManaToHealthMultiplier', 'float', 2.8, 'Recharge', { engine: true }),
  o('ClearLevelBoostFlagOnCast', 'bool', true, 'Recharge', { help: 'When true, RechargeBoost only applies to the first spell cast after switching to magic mode', engine: true }),
  // Melee / spell combat
  o('EnableCombat', 'bool', true, 'Melee Combat', { label: 'Enable Combat', help: 'Enable/Disable Combat', engine: true }),
  o('DefaultMeleeAttackHeight', 'enum', 2, 'Melee Combat', { values: { 1: 'High', 2: 'Medium', 3: 'Low' }, engine: true }),
  o('TargetLock', 'bool', false, 'Melee Combat', { engine: true }),
  o('TargetSelectMethod', 'enum', 3, 'Melee Combat', { values: { 1: 'By Range', 2: 'By Angle', 3: 'Both' }, engine: true }),
  o('TargetSelectAngleRange', 'range', yd(0.0208333), 'Melee Combat', { engine: true }),
  o('DebuffEachFirst', 'enum', 1, 'Melee Combat', { values: { 1: 'One', 2: 'Priority', 3: 'All' }, engine: true }),
  o('AutoAttackPower', 'bool', true, 'Melee Combat', { engine: true }),
  o('DebuffSelectionMethod', 'enum', 2, 'Melee Combat', { values: { 1: 'Spell Level', 2: 'Skill' }, engine: true }),
  o('UseRecklessness', 'bool', true, 'Melee Combat', { engine: true }),
  o('SpellDiffExcessThreshold-Hunt', 'int', 25, 'Spell Combat', { engine: true }),
  o('MinimumRingTargets', 'int', 4, 'Spell Combat', { engine: true }),
  o('SwitchWandsToDebuff', 'bool', false, 'Spell Combat', { aliases: ['SwitchWandToDebuff'], engine: true }),
  o('DoJiggle', 'bool', false, 'Spell Combat'),
  o('UseArcs', 'enum', 1, 'Spell Combat', { values: { 1: 'No', 2: 'At Range', 3: 'Yes' }, engine: true }),
  o('ArcRange', 'range', yd(0.0208333), 'Spell Combat', { engine: true }),
  o('DebuffPrecastSeconds', 'int', 5, 'Spell Combat', { engine: true }),
  o('SummonPets', 'bool', true, 'Spell Combat', { label: 'Summon Pets', engine: true }),
  o('PetRangeMode', 'enum', 0, 'Spell Combat', { label: 'Custom Pet Range:', values: { 0: 'AttackDistance', 1: 'PetCustomRange' }, engine: true }),
  o('PetCustomRange', 'range', yd(0.0208333), 'Spell Combat', { engine: true }),
  o('PetRefillCount-Idle', 'int', 3, 'Spell Combat', { engine: true }),
  o('PetRefillCount-Normal', 'int', 1, 'Spell Combat', { engine: true }),
  o('PetMonsterDensity', 'int', 1, 'Spell Combat', { label: 'Pet Min. Monsters:', engine: true }),
  o('UseBreakableTurnTo', 'bool', true, 'Spell Combat', { engine: true }),
  o('UseProjectileAwareness', 'bool', true, 'Spell Combat', { engine: true }),
  o('CollisionProjectileRadius', 'float', 0.4, 'Spell Combat'),
  o('CollisionStepDistance', 'float', 0.7, 'Spell Combat'),
  o('ShowCollisionDebug', 'bool', false, 'Spell Combat'),
  o('MaximumCollisionChecksPerTick', 'int', 500, 'Spell Combat'),
  o('SpellRangeFudge', 'float', 1, 'Spell Combat', { help: 'Metres taken off a debuff\'s range, as positions are not exact', engine: true }),
  o('AllowDebuffFallback', 'bool', false, 'Spell Combat', { engine: true }),
  // Ranges (in metres here; VTank's map units × 240)
  o('AttackDistance', 'range', yd(0.0208333), 'Ranges', { label: 'Monster Range:', help: 'The maximum range at which the macro will attempt to engage targets', engine: true }),
  o('AttackMinimumDistance', 'range', 0, 'Ranges', { engine: true }),
  o('ApproachDistance', 'range', 0, 'Ranges', { label: 'Approach', help: 'With navigation on, run toward a monster within this range until it is within Monster Range', engine: true }),
  o('RingDistance', 'range', yd(0.0208333), 'Ranges', { label: 'Ring Range:', engine: true }),
  o('CorpseApproachRange-Max', 'range', 0, 'Ranges', { help: 'How far the macro walks to a corpse (beyond arm\'s reach); the Approach box sets it too', engine: true }),
  o('CorpseApproachRange-Min', 'range', yd(0.014), 'Ranges', { aliases: ['CorpeApproachRange-Min'], help: 'How near the macro walks before opening a corpse', engine: true }),
  o('NavCloseStopRange', 'range', yd(0.0083333), 'Ranges', { label: 'Follow/Nav Min', help: 'How near a waypoint counts as reaching it', engine: true }),
  o('NavFarStopRange', 'range', 999999 * 240, 'Ranges', { engine: true }),
  o('UsePortalDistance', 'range', yd(0.0166667), 'Ranges', { engine: true }),
  o('DoorIDRange', 'range', yd(0.0833333), 'Ranges', { help: 'The range at which the macro will ID doors, when opening.', engine: true }),
  o('DoorOpenRange', 'range', yd(0.0166667), 'Ranges', { help: 'The range at which the macro will attempt to open a door.', engine: true }),
  // Navigation
  o('EnableNav', 'bool', false, 'Navigation', { label: 'Enable Navigation', help: 'Enable/Disable Navigation', engine: true }),
  o('NavPriorityBoost', 'bool', false, 'Navigation', { label: 'Boost Nav. Priority', help: 'Navigate before attacking', engine: true }),
  o('CorpseCacheTimeoutMinutes', 'float', 60, 'Navigation', { help: 'How long what is known about a corpse out of sight is kept', engine: true }),
  o('OpenDoors', 'bool', false, 'Navigation', { engine: true }),
  o('DoorLockpickDiffExcessThreshold', 'int', -50, 'Navigation', { help: 'The number of lockpick skill points above a door\'s pick difficulty that is required for a door to be considered pickable.', engine: true }),
  o('FollowAroundCorners', 'bool', true, 'Navigation', { help: 'Follow routes run the leader\'s own path, corner by corner (off: straight at them)', engine: true }),
  // Show Nav Lines (VTank's Options-tab switch; MOSS keeps it off by default): the loaded route drawn in the world (scene/NavLines.ts).
  o('ShowNavLines', 'bool', false, 'Navigation', { label: 'Show Nav Lines', help: 'Draws the loaded route in the world', engine: true }),
  // Buffing
  o('EnableBuffing', 'bool', true, 'Buffing', { label: 'Enable Buffing', engine: true }),
  o('SpellDiffExcessThreshold-Buff', 'int', 5, 'Buffing', { engine: true }),
  o('IdleBuffTopoff', 'bool', false, 'Buffing', { label: 'Rebuff When Idle', aliases: ['IdleBuffTOpoff'], engine: true }),
  o('IdleBuffTopoffTimeSeconds', 'int', 1200, 'Buffing', { engine: true }),
  o('RebuffTimeRemainingSeconds', 'int', 300, 'Buffing', { engine: true }),
  o('BuffProfile-Prots', 'string', 'ALFCBPS', 'Buffing', { engine: true }),
  o('BuffProfile-Banes', 'string', 'ALFCBPS', 'Buffing', { engine: true }),
  o('BuffProfile_Prots', 'enum', 2, 'Buffing', { values: { 1: 'Custom', 2: 'All', 3: 'None', 4: 'B', 5: 'BPS', 6: 'BPSA', 7: 'ALFC', 8: 'BPSAC' }, engine: true }),
  o('BuffProfile_Banes', 'enum', 2, 'Buffing', { values: { 1: 'Custom', 2: 'All', 3: 'None', 4: 'B', 5: 'BPS', 6: 'BPSA', 7: 'BPSAC', 8: 'ALFC' }, engine: true }),
  o('BuffCastRecast_Seconds', 'int', 30, 'Buffing', { engine: true }),
  o('BuffCastRecastReset_Seconds', 'int', 30, 'Buffing', { engine: true }),
  o('FastCastBuffs', 'bool', false, 'Buffing', { help: 'Moves you backwards during casting, use with caution', engine: true }),
  o('BuffWithUntrained-Item', 'int', 80, 'Buffing', { engine: true }),
  o('BuffWithUntrained-Creature', 'int', 80, 'Buffing', { engine: true }),
  o('BuffWithUntrained-Life', 'int', 80, 'Buffing', { engine: true }),
  // Crafting
  o('ArrowheadFletchDiffExcessThreshold', 'int', 10, 'Crafting', { aliases: ['ArrowheadFletchDiffExcessTheshold'], engine: true }),
  o('AutoCraftItems', 'bool', true, 'Crafting', { engine: true }),
  o('SplitPeas', 'bool', true, 'Crafting', { help: 'Splits peas to keep the spell components in the Consumables panel supplied', engine: true }),
  o('SpellCompMin-Critical', 'int', 4, 'Crafting', { help: 'Fewer of a component than this: split a pea before healing', engine: true }),
  o('SpellCompMin-Normal', 'int', 20, 'Crafting', { help: 'Fewer than this: split a pea after normal buffing', engine: true }),
  o('SpellCompMin-Idle', 'int', 20, 'Crafting', { help: 'Fewer than this: split a pea when idle', engine: true }),
  o('UseSpecialAmmo', 'enum', 0, 'Crafting', { values: { 0: 'None', 1: 'Raider', 2: 'SCurrency', 3: 'Both' }, engine: true }),
  o('IdleCraftCount_HealthKits', 'int', 2, 'Crafting', { engine: true }),
  o('IdleCraftCount_StamKits', 'int', 2, 'Crafting', { engine: true }),
  o('IdleCraftCount_ManaKits', 'int', 2, 'Crafting', { engine: true }),
  o('IdleCraftCount_HealthFood', 'int', 15, 'Crafting', { engine: true }),
  o('IdleCraftCount_StamFood', 'int', 15, 'Crafting', { engine: true }),
  o('IdleCraftCount_ManaFood', 'int', 15, 'Crafting', { engine: true }),
  o('BlacklistedSpellComps', 'string', '', 'Crafting'),
  // Looting
  o('EnableLooting', 'bool', false, 'Looting', { label: 'Enable Looting', help: 'Loots corpses with the loot profile', engine: true }),
  o('ReadUnknownScrolls', 'bool', true, 'Looting', { help: 'Loots and reads scrolls of spells you can learn', engine: true }),
  o('LootAllCorpses', 'bool', false, 'Looting', { help: 'Also loots others\' corpses, 100 s after they appear', engine: true }),
  o('LootFellowCorpses', 'bool', false, 'Looting', { help: 'Also loots fellows\' kills (at once when they share loot, else after 100 s)', engine: true }),
  o('LootPriorityBoost', 'bool', false, 'Looting', { label: 'Boost Loot Priority', help: 'Loots corpses before attacking the next monster', engine: true }),
  o('LootOnlyRareCorpses', 'bool', false, 'Looting', { label: 'Loot Only Rare Corpses', engine: true }),
  o('CorpseItemAppearanceTimeoutSeconds', 'float', 6, 'Looting', { help: 'How long an opened corpse waits for its items before it counts as empty', engine: true }),
  o('CorpseItemIDTimeoutSeconds', 'float', 60, 'Looting', { help: 'How long an item on a corpse waits for its examination', engine: true }),
  o('CorpseOpenTimeoutSeconds', 'float', 1.5, 'Looting', { help: 'How long an open may take before it counts as a failed attempt', engine: true }),
  o('CorpseLootItemMaxAttempts', 'int', 20, 'Looting', { help: 'Picks of one item before it is left on the corpse', engine: true }),
  o('CombineSalvage', 'bool', true, 'Looting', { label: 'Combine Salvage', help: 'Combines partial salvage bags of one material by the loot profile\'s workmanship bands', engine: true }),
];

const BY_NAME = new Map<string, VtOption>();
for (const x of VT_OPTIONS) { BY_NAME.set(x.name.toLowerCase(), x); for (const a of x.aliases ?? []) BY_NAME.set(a.toLowerCase(), x); }

/** The option by any spelling VTank accepts (case-insensitive, wiki aliases). */
export function vtOption(name: string): VtOption | undefined { return BY_NAME.get(name.trim().toLowerCase()); }
/** The name VTank stores an option under (an unknown name is kept as given: plugins add their own). */
export function vtCanonicalName(name: string): string { return vtOption(name)?.name ?? name.trim(); }

/** A value in VTank's own units (as `/vt opt get` and vtgetsetting give it): ranges ÷ 240. */
export function vtToVTank(name: string, v: string | number | boolean): string | number | boolean {
  return vtOption(name)?.kind === 'range' && typeof v === 'number' ? v / 240 : v;
}
/** A value VTank gave (an imported `/vt opt set`, vtsetsetting) in our units: ranges × 240, and typed by the option. */
export function vtFromVTank(name: string, v: string | number | boolean): string | number | boolean {
  const opt = vtOption(name);
  const typed = typeValue(opt, v);
  return opt?.kind === 'range' && typeof typed === 'number' ? Math.round(typed * 240 * 1000) / 1000 : typed;
}
/** A value the player typed in the window (ranges in yards = our metres), typed by the option. */
export function vtStoredValue(name: string, text: string | number | boolean): string | number | boolean { return typeValue(vtOption(name), text); }
/** A stored value as the window shows it. */
export function vtDisplayValue(_name: string, v: string | number | boolean): string | number | boolean { return v; }

function typeValue(opt: VtOption | undefined, v: string | number | boolean): string | number | boolean {
  const s = typeof v === 'string' ? v.trim() : v;
  if (!opt) return typeof s === 'string' && /^(true|false)$/i.test(s) ? /^true$/i.test(s) : typeof s === 'string' && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
  if (opt.kind === 'bool') return s === true || s === 1 || (typeof s === 'string' && /^(true|1|yes|on)$/i.test(s));
  if (opt.kind === 'string') return String(s);
  const num = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(num)) return opt.default;
  return opt.kind === 'int' || opt.kind === 'enum' ? Math.round(num) : num;
}

/**
 * What one control writes besides its own option: VTank's Approach box also sets the corpse approach
 * range, which is why a profile with an Approach walks to corpses at all (MOSS MossTankPanel, facts only).
 * `/vt opt set` sets only the option named.
 */
export function vtLinkedSettings(name: string, value: string | number | boolean): Record<string, string | number | boolean> {
  const n = vtCanonicalName(name);
  const out: Record<string, string | number | boolean> = { [n]: value };
  if (n === 'ApproachDistance') out['CorpseApproachRange-Max'] = value;
  return out;
}

/** Every default, by name (the engine's starting settings for a macro profile). */
export function vtDefaults(): Record<string, string | number | boolean> {
  return Object.fromEntries(VT_OPTIONS.map((x) => [x.name, x.default]));
}
