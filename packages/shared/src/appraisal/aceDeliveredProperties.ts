/**
 * What an end-of-retail ACE server actually tells a client about an object, by message.
 *
 * - Appraisal (IdentifyObjectResponse, GameEvent 0x00C9): ACE AppraiseInfo.BuildProperties
 *   (Network/Structure/AppraiseInfo.cs:342) copies only the properties tagged
 *   `[AssessmentProperty]` in ACE.Entity/Enum/Properties/*.cs, then BuildProfile adds a few it
 *   computes (ratings, allegiance titles, lockpick chance, …). It never writes an InstanceId
 *   table. Weapon numbers (Damage, Variance, DamageMod, Offense, WeaponTime, DamageType,
 *   WeaponSkill, MaxVelocity) and armor resistances (ArmorModVs*) come in the WeaponProfile /
 *   ArmorProfile sections, not as properties.
 * - PlayerDescription (login): only `[SendOnLogin]` keys, and only for your own character.
 * - CreateObject's weenie header: ItemsCapacity, ContainersCapacity, AmmoType, Value, Useable,
 *   UseRadius, TargetType, UiEffects, CombatUse, Structure, MaxStructure, StackSize,
 *   MaxStackSize, Container, Wielder, ValidLocations, CurrentWieldedLocation, Priority,
 *   RadarBlipColor/Behavior, PScript, Workmanship, Burden, Spell, House*, HookItemTypes, Monarch,
 *   HookType, IconOverlay/Underlay, MaterialType, Cooldown, CooldownDuration, PetOwner
 *   (WorldObject_Networking.cs). Those reach the client there, never through an appraisal.
 *
 * GDLE-family servers (GDLE, ClassicDereth, Seedsow, the AC1999 server) appraise with a
 * deny-list instead (ObjectMsgs.cpp: every quality but a few), so a property missing here may
 * still arrive there. Code that must work everywhere reads the CreateObject / profile source
 * first and an appraised property only as a fallback.
 *
 * The id lists are ACE's, checked against the reference source by
 * tests/verify-ace-delivered-properties.ts (ClassicACE has the same tags).
 * 2026-11-17: summoning essences were identified by PetClass (266), which ACE never sends, so
 * the feature was dead live while fixtures carrying 266 kept its tests green.
 */

export type AppraisalPropertyKind = 'int' | 'int64' | 'bool' | 'float' | 'string' | 'did';

const set = (ids: readonly number[]): ReadonlySet<number> => new Set(ids);

/** Property ids an ACE appraisal can carry: the [AssessmentProperty] tags plus what AppraiseInfo computes. */
export const ACE_APPRAISAL_PROPERTIES: Readonly<Record<AppraisalPropertyKind, ReadonlySet<number>>> = {
  int: set([
    2, 5, 17, 19, 25, 26, 28, 30, 33, 35, 36, 38, 43, 45, 47, 86, 87, 89, 90, 91, 92, 98, 105, 106, 107, 108,
    109, 110, 111, 113, 114, 115, 117, 125, 131, 134, 158, 159, 160, 166, 170, 171, 172, 173, 174, 175, 176,
    177, 178, 179, 181, 188, 192, 193, 204, 257, 258, 259, 260, 261, 262, 263, 265, 267, 268, 270, 271, 272,
    273, 274, 275, 276, 277, 278, 279, 280, 281, 287, 288, 289, 292, 303, 304, 305, 306, 307, 308, 313, 314,
    315, 316, 319, 320, 323, 324, 331, 350, 351, 352, 353, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375,
    376, 377, 378, 379, 381, 382, 383, 384, 386, 387, 388, 389, 390,
  ]),
  int64: set([3, 4, 5]),
  bool: set([2, 3, 63, 69, 85, 91, 94, 99, 100, 108, 130]),
  float: set([5, 29, 87, 100, 136, 137, 144, 147, 149, 150, 152, 155, 157, 159, 167]),
  string: set([5, 7, 8, 10, 14, 15, 16, 21, 23, 25, 35, 38, 39, 40, 43, 47, 52]),
  did: set([9, 10, 11, 15, 16, 17, 41, 55]),
};

/** Property ids ACE's PlayerDescription carries ([SendOnLogin]); your own character only. */
export const ACE_LOGIN_PROPERTIES: Readonly<Record<AppraisalPropertyKind | 'iid', ReadonlySet<number>>> = {
  int: set([
    5, 7, 20, 24, 25, 30, 40, 43, 47, 98, 113, 125, 129, 132, 134, 139, 181, 188, 192, 199, 218, 219, 220, 221,
    222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 240, 241, 242, 243,
    244, 245, 246, 281, 287, 288, 289, 294, 295, 296, 297, 298, 299, 300, 301, 302, 307, 308, 309, 310, 312,
    313, 314, 315, 316, 317, 318, 322, 323, 326, 328, 329, 330, 331, 333, 334, 335, 336, 337, 338, 339, 340,
    341, 342, 343, 344, 347, 350, 351, 354, 355, 360, 361, 362, 365, 370, 371, 372, 373, 374, 375, 376, 377,
    378, 379, 381, 382, 383, 384, 386, 387, 388, 389, 390,
  ]),
  int64: set([1, 2, 6, 7]),
  bool: set([21, 44, 45, 46, 47, 68, 97, 104, 124, 125, 127]),
  float: set([125, 163, 168, 169, 170, 171]),
  string: set([1, 5]),
  did: set([2, 4]),
  iid: set([24, 25]),
};

/** Whether an ACE appraisal can carry this property. */
export function aceAppraisalCarries(kind: AppraisalPropertyKind, id: number): boolean {
  return ACE_APPRAISAL_PROPERTIES[kind].has(id);
}

/** An appraisal's property maps (Map or plain record per kind). */
export interface AppraisalPropertyMaps {
  int?: ReadonlyMap<number, unknown> | Readonly<Record<number, unknown>>;
  int64?: ReadonlyMap<number, unknown> | Readonly<Record<number, unknown>>;
  bool?: ReadonlyMap<number, unknown> | Readonly<Record<number, unknown>>;
  float?: ReadonlyMap<number, unknown> | Readonly<Record<number, unknown>>;
  string?: ReadonlyMap<number, unknown> | Readonly<Record<number, unknown>>;
  did?: ReadonlyMap<number, unknown> | Readonly<Record<number, unknown>>;
}

const keysOf = (m: AppraisalPropertyMaps[keyof AppraisalPropertyMaps]): number[] =>
  !m ? [] : m instanceof Map ? [...m.keys()].map(Number) : Object.keys(m).map(Number);

/**
 * The properties in an appraisal that ACE never sends ("int 266", …); empty for a server-shaped one.
 * Tests that hand-build an ACE appraisal pass it through `aceShapedAppraisal` so a fixture can't
 * carry a property the live server never delivers.
 */
export function propertiesAceNeverAppraises(maps: AppraisalPropertyMaps): string[] {
  const out: string[] = [];
  for (const kind of ['int', 'int64', 'bool', 'float', 'string', 'did'] as const) {
    for (const id of keysOf(maps[kind])) if (!ACE_APPRAISAL_PROPERTIES[kind].has(id)) out.push(`${kind} ${id}`);
  }
  return out;
}

/** Returns the maps unchanged, or throws naming every property an ACE appraisal can't carry. */
export function aceShapedAppraisal<T extends AppraisalPropertyMaps>(maps: T): T {
  const bad = propertiesAceNeverAppraises(maps);
  if (bad.length) throw new Error(`ACE never sends these on an appraisal: ${bad.join(', ')} (ACE AppraiseInfo.BuildProperties sends only [AssessmentProperty] keys)`);
  return maps;
}

// ─── Profiles as properties ──────────────────────────────────────────────

/** IdentifyObjectResponse WeaponProfile (ACE WeaponProfile.cs): numbers with the item's enchantments folded in. */
export interface AppraisalWeaponProfile {
  damageType: number;
  weaponTime: number;
  weaponSkill: number;
  damage: number;
  damageVariance: number;
  damageMod: number;
  weaponOffense: number;
}

/** IdentifyObjectResponse ArmorProfile (ACE ArmorProfile.cs): effective resistance per damage type. */
export interface AppraisalArmorProfile {
  slashing: number; piercing: number; bludgeoning: number; cold: number;
  fire: number; acid: number; nether: number; lightning: number;
}

/**
 * The appraisal's int / float properties with the weapon and armor profiles written in under the
 * ACE property ids Decal's synthesized keys stand for (MaxDamage → Damage 44, Variance →
 * DamageVariance 22, AttackBonus → WeaponOffense 62, DamageBonus → DamageMod 63, SlashProt… →
 * ArmorModVs* 13–19, plus DamageType 45, WeaponSkill 48, WeaponTime 49 and ArmorModVsNether 165;
 * MaxVelocity stays out: ACE's 1.0 is a "none stored" placeholder, see appraisedMissileVelocity). Decal's WorldObject read those from the profiles; ACE sends them nowhere
 * else, so anything that keys on the property ids (Mag-Tools' item line, loot rules) saw nothing.
 * A property the server did send wins (GDLE sends many of these as properties too). A failed
 * appraisal's weapon profile (WeaponTime < 0, "Unknown") adds nothing.
 */
export function foldAppraisalProfiles(
  int: Readonly<Record<number, number>>,
  float: Readonly<Record<number, number>>,
  weapon?: AppraisalWeaponProfile | null,
  armor?: AppraisalArmorProfile | null,
): { int: Record<number, number>; float: Record<number, number> } {
  const outInt: Record<number, number> = { ...int };
  const outFloat: Record<number, number> = { ...float };
  const putInt = (id: number, v: number) => { if (outInt[id] === undefined) outInt[id] = v; };
  const putFloat = (id: number, v: number) => { if (outFloat[id] === undefined) outFloat[id] = v; };
  if (weapon && weapon.weaponTime >= 0) {
    putInt(44, weapon.damage);
    if (weapon.damageType) putInt(45, weapon.damageType);
    if (weapon.weaponSkill) putInt(48, weapon.weaponSkill);
    putInt(49, weapon.weaponTime);
    putFloat(22, weapon.damageVariance);
    putFloat(62, weapon.weaponOffense);
    putFloat(63, weapon.damageMod);
  }
  if (armor) {
    putFloat(13, armor.slashing);
    putFloat(14, armor.piercing);
    putFloat(15, armor.bludgeoning);
    putFloat(16, armor.cold);
    putFloat(17, armor.fire);
    putFloat(18, armor.acid);
    putFloat(19, armor.lightning);
    putFloat(165, armor.nether);
  }
  return { int: outInt, float: outFloat };
}
