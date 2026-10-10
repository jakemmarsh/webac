/**
 * SWEEP1006 world use — what using an object does, as retail's
 * ItemHolder::UseObject @ 00588a80 decides it (annotated decomp :377560)
 * with ItemHolder::DetermineUseResult @ 00588460 and
 * CPlayerSystem::UsingItem @ 00562f70. Every world Use (the double-click
 * — RecvNotice_SmartBoxObjectFound sr_Use → UseObject(selectedID, 0, 0) —
 * the Use key, the toolbar) goes through it.
 *
 * Pre-fix ours sent GameAction Use for anything that was not attackable in
 * a combat mode: a peace-mode double-click on a monster (ItemUseable No)
 * made ACE walk the player up to it, and a double-clicked item on the
 * ground was "used" instead of picked up (DetermineUseResult case 2).
 *
 * The 0x1a spew lines are the retail literals, read from acclient.exe
 * .rdata (UTF-16) at the addresses UseObject pushes: 0x7e2bf8 trading,
 * 0x7e25c0 wield, 0x7e2ba8 select-target, 0x7e2b6c choose-target,
 * 0x7e2b4c "Approaching %s" (a creature) / 0x7ce214 "Using the %s",
 * 0x7e2af8 door, 0x7e2aa0 dove, 0x7e2a70 cannot-be-used.
 */

/** PublicWeenieDesc._bitfield (ACE ObjectDescriptionFlag) bits UseObject reads. */
export const BF_STUCK = 0x4;
export const BF_PK_SWITCH = 0x400;
export const BF_NPK_SWITCH = 0x800;
export const BF_DOOR = 0x1000;
export const BF_REQUIRES_PACK_SLOT = 0x800000;
export const BF_VOLATILE_RARE = 0x10000000;
export const BF_WIELD_ON_USE = 0x20000000;
export const BF_WIELD_LEFT = 0x40000000;

/** ITEM_TYPE bits (vtable +0x18). */
const TYPE_CREATURE = 0x10;
const TYPE_CASTER = 0x8000;
const TYPE_TINKERING_TOOL = 0x20000000;
const TYPE_GAMEBOARD = 0x80000000;

/** ITEM_USEABLE (ItemUses) bits. */
export const USEABLE_NO = 0x1;
export const USEABLE_SELF = 0x2;
export const USEABLE_WIELDED = 0x4;
export const USEABLE_CONTAINED = 0x8;
export const USEABLE_VIEWED = 0x10;
export const USEABLE_REMOTE = 0x20;

/** ItemUses::IsUseable @ 004fccc0 — `~bitfield & 1`: anything without the No bit (0 included). */
export function isUseable(useability: number): boolean {
  return (useability & USEABLE_NO) === 0;
}

/** ItemUses::IsUseable_Targeted @ 004fcd10 — the target half (high 16 bits) is non-zero. */
export function isUseableTargeted(useability: number): boolean {
  return ((useability >>> 0) & 0xffff0000) !== 0;
}

/** ItemUses::GetLeastLimitedSourceUse @ 004fccd0. */
export function leastLimitedSourceUse(useability: number): number {
  if (useability & USEABLE_REMOTE) return USEABLE_REMOTE;
  if (useability & USEABLE_VIEWED) return USEABLE_VIEWED;
  if (useability & USEABLE_CONTAINED) return USEABLE_CONTAINED;
  if (useability & USEABLE_WIELDED) return USEABLE_WIELDED;
  return useability & USEABLE_SELF;
}

/** The PublicWeenieDesc slice DetermineUseResult / UseObject read. */
export interface UseSubject {
  guid: number;
  name: string;
  containerId: number;
  wielderId: number;
  /** PublicWeenieDesc._bitfield (ObjectDescriptionFlag). */
  bitfield: number;
  itemsCapacity: number;
  containersCapacity: number;
  itemType: number;
  combatUse: number;
  validLocations: number;
  /** _location: the slots it is worn in (0 when not wielded). */
  location: number;
  /** _useability (ItemUseable). */
  useability: number;
  /** IsOwnedByPlayer: in our packs, worn, or ourselves. */
  ownedByPlayer: boolean;
  /** vtable +0x10: a player character. */
  isPlayer: boolean;
  /** this->tradeState == 1: on the trade window. */
  beingTraded?: boolean;
  /** ACCWeenieObject::IsComponentPack @ 00588400: the wcid is in the ComponentPacks table. */
  componentPack?: boolean;
}

/**
 * The DualDidMapper IsComponentPack reads: DBObj::GetByEnum(5, 0x10000001,
 * 0x28) resolves master DidMapper 0x25000000 [0x10000001] → 0x25000005
 * (Materials / Gems / SpellComponents / SchoolOfMagic / ComponentPacks / …)
 * [5 "ComponentPacks"] → 0x27000003. Its client ids are the five foci
 * (packwaressence 15271, packlifeessence 15270, packitemessence 15269,
 * packcreatureessence 15268, packvoidessence 43173).
 */
export const COMPONENT_PACKS_DID_MAPPER_ID = 0x27000003;

/** ACCWeenieObject::IsComponentPack @ 00588400 — the wcid hashes into the table's id set. */
export function isComponentPack(wcid: number, packWcids: ReadonlySet<number>): boolean {
  return wcid !== 0 && packWcids.has(wcid >>> 0);
}

/** An item in our packs or worn (playerState inventory / equipment). */
export interface OwnedUseItem {
  name: string;
  containerId?: number;
  itemType?: number;
  combatUse?: number;
  validLocations?: number;
  /** Worn slot (equipment only). */
  slot?: number;
  usable?: number;
  /** PublicWeenieDesc._bitfield as the item's CreateObject carried it. */
  objectDescFlags?: number;
}

/**
 * The UseSubject of an item we own. Its _bitfield is the item's own
 * ObjectDescriptionFlag word: UseObject reads it for the volatile-rare
 * confirmation (BF_VOLATILE_RARE) and WieldOnUse / WieldLeft whatever
 * window the item is used from.
 */
export function ownedUseSubject(guid: number, item: OwnedUseItem, playerGuid = 0): UseSubject {
  // SWEEP1006B — a worn item is wielded BY the player and in no container
  // (ACE clears ContainerId on wield), so DetermineUseResult takes it to
  // case 2 (PlaceInBackpack: unwield into the pack), not to AutoWield.
  const worn = (item.slot ?? 0) !== 0;
  return {
    guid, name: item.name, containerId: worn ? 0 : item.containerId ?? 0, wielderId: worn ? playerGuid : 0,
    bitfield: item.objectDescFlags ?? 0,
    itemsCapacity: 0, containersCapacity: 0, itemType: item.itemType ?? 0, combatUse: item.combatUse ?? 0,
    validLocations: item.validLocations ?? 0, location: item.slot ?? 0,
    useability: item.usable ?? 0, ownedByPlayer: true, isPlayer: false,
  };
}

/**
 * The UseSubject of an item we carried that now sits in another container
 * (a chest we stored it in, a vendor). The client keeps the weenie
 * (ServerSaysMoveItem @ 0058dbb0 only moves it), so UseObject reads the same
 * PublicWeenieDesc, now contained by `containerId` and no longer ours.
 */
export function containedUseSubject(guid: number, item: OwnedUseItem, containerId: number): UseSubject {
  return { ...ownedUseSubject(guid, { ...item, slot: 0 }), containerId: containerId >>> 0, wielderId: 0, location: 0, ownedByPlayer: false };
}

export interface UseContext {
  playerGuid: number;
  /** ClientUISystem::groundObject: the open ground container (0 = none). */
  groundObject: number;
}

/**
 * ItemHolder::DetermineUseResult @ 00588460: 2 pick up, 3 wield (right),
 * 8 wield (left), 4 auto-sort (wear), 5 trade, 6 salvage panel, 7 game
 * board, 1 plain use, 0 nothing. A container-like object (RequiresPackSlot
 * or a capacity) takes the general path unless it is a component pack
 * (ACCWeenieObject::IsComponentPack): a focus on the ground is picked up.
 */
export function determineUseResult(o: UseSubject, ctx: UseContext): number {
  let general = false;
  if (o.containerId !== 0 || (o.bitfield & BF_STUCK) !== 0) {
    if (ctx.groundObject === 0 || o.containerId !== ctx.groundObject) general = true;
  }
  if (!general && o.wielderId !== 0 && o.wielderId !== ctx.playerGuid) general = true;
  if (!general) {
    const containerLike = (o.bitfield & BF_REQUIRES_PACK_SLOT) !== 0 || o.itemsCapacity !== 0 || o.containersCapacity !== 0;
    if (!containerLike || o.componentPack) return 2;
  }
  const t = o.itemType >>> 0;
  if (!o.ownedByPlayer) {
    if ((t & TYPE_GAMEBOARD) !== 0) return 7;
  } else {
    if ((o.combatUse !== 0 || (t & TYPE_CASTER) !== 0 || (o.bitfield & BF_WIELD_ON_USE) !== 0) && o.wielderId !== ctx.playerGuid) {
      return (o.bitfield & BF_WIELD_LEFT) !== 0 ? 8 : 3;
    }
    const v = o.validLocations >>> 0, l = o.location >>> 0;
    if (((v & 0x7e00) !== 0 && (l & 0x7e00) === 0)
      || ((v & 0x80001ff) !== 0 && (l & 0x80001ff) === 0)
      || ((v & 0x7c0f8000) !== 0 && (l & 0x7c0f8000) === 0)) return 4;
    if ((t & TYPE_TINKERING_TOOL) !== 0) return 6;
  }
  if (isUseable(o.useability)) return 1;
  if (o.isPlayer && o.guid !== ctx.playerGuid) return 5;
  return 0;
}

export type UseDecision =
  /** CPlayerSystem::UsingItem's DetermineUseResult case (2–8). */
  | { kind: 'usingItem'; result: number }
  /** Event_UseEvent (+ IncrementBusyCount), then the spew line. */
  | { kind: 'use'; text: string }
  /** A PK / NPK altar or a volatile rare: retail's confirmation dialog first. */
  | { kind: 'confirm'; which: 'pkAltar' | 'npkAltar' | 'volatileRare' }
  /** Event_UseWithTargetEvent on the selection (param_2 set, a selection). */
  | { kind: 'useWithSelection'; target: number }
  /** SetTargetMode(TARGET_MODE_USE_TARGET) + the spew line. */
  | { kind: 'targetMode'; text: string }
  /** The 0x1a spew line only. */
  | { kind: 'message'; text: string }
  /** Nothing at all (attackable in a combat mode; self; an incompatible selection). */
  | { kind: 'silent' };

export interface UseObjectContext extends UseContext {
  /** param_2: a targeted item may use the current selection. */
  allowSelection: boolean;
  /** param_3: skip DetermineUseResult (the endowment path). */
  skipDetermine: boolean;
  selectedGuid: number;
  /** ClientCombatSystem::ObjectIsAttackable(guid). */
  attackable: boolean;
  /** combatMode == NONCOMBAT_COMBAT_MODE. */
  peaceMode: boolean;
  /** PlayerModule::ConfirmVolatileRareUse (the option is on). */
  confirmVolatileRare: boolean;
  /** TargetCompatibleWithObject(selected, item, false, true). */
  selectionCompatible: boolean;
}

/** ItemHolder::UseObject @ 00588a80 (after its time / readiness / vendor gates). */
export function decideUseObject(o: UseSubject, ctx: UseObjectContext): UseDecision {
  if (!ctx.skipDetermine) {
    const r = determineUseResult(o, ctx);
    if (r > 1 && r < 8) return { kind: 'usingItem', result: r };
  }
  if (o.beingTraded) return { kind: 'message', text: `You cannot use the ${o.name} because you are trading it` };
  if (o.location === 0 && (leastLimitedSourceUse(o.useability) & USEABLE_WIELDED) !== 0) {
    return { kind: 'message', text: `You must wield the ${o.name} to use it` };
  }
  if (isUseableTargeted(o.useability)) {
    if (!ctx.allowSelection) return { kind: 'targetMode', text: `Choose a target for the ${o.name}` };
    if (ctx.selectedGuid !== 0) return ctx.selectionCompatible ? { kind: 'useWithSelection', target: ctx.selectedGuid } : { kind: 'silent' };
    return { kind: 'message', text: `Select your target before using the ${o.name}` };
  }
  if (!isUseable(o.useability)) {
    // UsingItem(guid, 0, param_3) runs here too (an owned container opens).
    if (o.guid === ctx.playerGuid) return { kind: 'silent' };
    if ((o.bitfield & BF_DOOR) !== 0) return { kind: 'message', text: `You can't open or close this ${o.name} that way` };
    if (ctx.attackable && ctx.peaceMode) return { kind: 'message', text: `To attack ${o.name}, click on the dove icon first` };
    if (ctx.attackable) return { kind: 'silent' };
    return { kind: 'message', text: `The ${o.name} cannot be used` };
  }
  if ((o.bitfield & BF_PK_SWITCH) !== 0) return { kind: 'confirm', which: 'pkAltar' };
  if ((o.bitfield & BF_NPK_SWITCH) !== 0) return { kind: 'confirm', which: 'npkAltar' };
  if ((o.bitfield & BF_VOLATILE_RARE) !== 0 && ctx.confirmVolatileRare) return { kind: 'confirm', which: 'volatileRare' };
  const creature = ((o.itemType >>> 0) & TYPE_CREATURE) !== 0;
  return { kind: 'use', text: creature ? `Approaching ${o.name}` : `Using the ${o.name}` };
}

/** ClientUISystem::UsageConfirmation_* @ 00566420 / 00566610 / 00566800 — the dialog text (wide literals in the binary). */
export const USAGE_CONFIRMATION_TEXT: Readonly<Record<'pkAltar' | 'npkAltar' | 'volatileRare', string>> = {
  pkAltar: 'Using this altar will make you a player killer, able to attack or be attacked by other player killers. Are you sure you want to do this?',
  npkAltar: 'Using this altar will make you a non-player killer, unable to attack or be attacked by other player killers. Are you sure you want to do this?',
  volatileRare: 'Are you sure you want to use this rare item?',
};
