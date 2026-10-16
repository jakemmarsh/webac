export * from './types.js';
export { encodeWindows1252, decodeWindows1252 } from './encoding/Windows1252.js';
export * from './weenie-types.js';
export * from './game-types.js';
export * from './item-types.js';
export * from './ace-enums.js';
export { TerrainCollision } from './physics/TerrainCollision.js';
export { WaterMap, LandWaterType, isWaterTerrainType, WATER_DEPTH_ENTIRELY, WATER_DEPTH_PARTIAL_WATER_VERTEX, WATER_DEPTH_PARTIAL_DRY_VERTEX } from './physics/WaterMap.js';
export { computeCellSplitDir } from './physics/CellSplitDir.js';
export {
  buildCollisionBSP, sphereIntersectsPoly, sphereIntersectsAnyPoly, sphereIntersectsSolid,
  findFloorHeight, collectWalkableFloorHeights, collectWalkableFloors, findCrossedEdge, findWalkable, collectWalkableSphereHits, sphereRestLift,
  makePlane, polygonHitsSpherePrecise, posHitsSphere, FLOOR_WALKABLE_Z,
} from './physics/CollisionBSP.js';
export type {
  CollisionBSPNode, CollisionPlane, CollisionSphere,
  PhysicsPolygon, CollisionHit, WalkableFloor, WalkablePath,
} from './physics/CollisionBSP.js';
export {
  getRunRate, getClientRunRate, getPlayerRunRate, getJumpHeight, getJumpVelocity, getJumpStaminaCost, jumpSkillWithStamina, integrateAirborneStep,
  getEncumbranceCapacity, getBurden, getBurdenMod, BACKWARDS_FACTOR, SIDESTEP_FACTOR,
  RUN_ANIM_SPEED, WALK_ANIM_SPEED, SIDESTEP_ANIM_SPEED, MAX_SIDESTEP_ANIM_RATE,
  RUN_TURN_FACTOR,
} from './physics/MovementSystem.js';
export {
  physicsQuantumSteps, physicsQuantumDelta, smartBoxPhysicsSteps,
  MIN_QUANTUM, MAX_QUANTUM, HUGE_QUANTUM,
} from './physics/PhysicsQuantum.js';

// Character creation
export {
  Heritage, Gender, SkillAdvancementClass, StartingTown, WeaponType, weaponTypeLabel,
} from './character/Heritage.js';
export { ATTRIBUTE_MIN, ATTRIBUTE_MAX, DEFAULT_ATTRIBUTE_CREDITS } from './character/StartingAttributes.js';
export {
  validateName, validateNameWithRules, validateAttributes, CreateResult,
} from './character/CharacterCreation.js';
export type {
  CharacterCreateInfo, AppearanceInfo, NameFilterRules, TabooPredicate,
} from './character/CharacterCreation.js';

// Attribute/Skill/Vital/XP systems (Phase 21)
export { AttributeSystem, AttributeId } from './character/AttributeSystem.js';
export type { Attribute } from './character/AttributeSystem.js';
export {
  VitalSystem, VitalId, REGEN_INTERVAL, RegenStance,
  getHealthRegenAttributeMod, getRegenStanceMod, getAugmentationRegenMod,
  PLAYER_WEENIE_REGEN_RATES, VITAL_MAX_KEY, VITAL_RATE_KEY,
} from './character/VitalSystem.js';
export type { Vital, VitalFormulaTable, VitalStatContext } from './character/VitalSystem.js';
export { SkillSystem, computeSkillBase, computeSkillFormula } from './character/SkillSystem.js';
export {
  playerStatModsFromIntProps, getAttributeCurrent, getSkillAugBonusBase, getSkillAugBonusCurrent,
  getSkillBaseValue, getSkillCurrent, getPlayerEncumbranceCapacity,
  MELEE_SKILLS, MISSILE_SKILLS, MAGIC_SKILLS,
} from './character/CreatureStats.js';
export type { PlayerStatMods } from './character/CreatureStats.js';
export type { Skill } from './character/SkillSystem.js';
export { XpSystem } from './character/XpSystem.js';
export {
  getEvenSplitXpPctg, getExperienceProportion, getFellowshipXpSharePercent, getFellowshipXpShareDisplayPercent,
} from './character/FellowshipXpShare.js';
export { LUMINANCE_MIN_LEVEL } from './character/LuminanceSystem.js';

// Inventory/Equipment (Phase 22)
export { InventoryManager } from './inventory/InventoryManager.js';
export { shopSellPrice, shopBuyPrice, vendorSellPrice, vendorBuyPrice, unitValueOf, TYPE_PROMISSORY_NOTE } from './inventory/vendorPricing.js';
export type { InventoryItem } from './inventory/InventoryManager.js';
export { EquipmentSystem, OptimisticEquipmentTracker } from './inventory/EquipmentSystem.js';
export { resolveAutoWield, blocksUseOfShield, isMergeAttemptLegal, UISlotSide, AUTOWIELD_CANNOT_WIELD_MORE, autoWieldRetryDue } from './inventory/AutoWield.js';
export type { AutoWieldItem, AutoWieldResolution, AutoWieldStack, EquippedLookup, PendingAutoWieldRetry } from './inventory/AutoWield.js';
export type { EquippedItem, WieldRequirement, EquipResult, PendingEquipmentAction } from './inventory/EquipmentSystem.js';
export { getAppropriateName, getPluralName } from './inventory/objectName.js';
export {
  InventoryRequest, InventoryRequestTracker, ATTEMPT_FAILED_VERB, ATTEMPT_FAILED_SUFFIX,
  INVENTORY_REQUEST_PENDING_TEXT, INVENTORY_REQUEST_ATTACKING_TEXT, inventoryRequestRefusalText,
  attemptFailedObjectName, attemptFailedVerbLine, attemptFailedSuffix, attemptFailedText,
} from './inventory/InventoryRequest.js';
export type { AttemptFailedNameType, AttemptFailedVerb, AttemptFailedObject, PendingInventoryRequest, InventoryRequestRefusal } from './inventory/InventoryRequest.js';

// Combat (Phase 23)
export {
  AttackHeight, CombatMode, CombatUse, getDefaultCombatMode, getAutoEnterAttackPlan,
} from './combat/CombatSystem.js';
export { WeenieError, weenieErrorText, substituteWeenieErrorItemName } from './combat/WeenieErrorText.js';
export {
  WEENIE_ERROR_TEXT_TYPE, WEENIE_ERROR_NOTICE_ONLY, WEENIE_ERROR_TEXT_TYPE_CHAT, WEENIE_ERROR_TEXT_TYPE_MAGIC,
  WEENIE_ERROR_TEXT_TYPE_SPEW, weenieErrorTextType, weenieErrorSink, type WeenieErrorSink,
} from './combat/WeenieErrorSink.js';
export {
  WeenieErrorWithString, WEENIE_ERROR_WITH_STRING_TEXT, weenieErrorWithStringText,
  formatWeenieErrorWithString,
} from './combat/WeenieErrorWithStringText.js';
export {
  getSwingAnimation, getWeaponAttackType, getOffhandAttackType, getUnarmedAttackType,
  selectSwingMotion, isThrustSlash, getWeaponStance, addShieldStance,
  THRUST_THRESHOLD, KICK_THRESHOLD, STANCE as SWING_STANCE,
} from './combat/SwingAnimation.js';
export type { CombatManeuverRow, SwingAnimationInput } from './combat/SwingAnimation.js';
export { getAnimSpeed, MIN_ATTACK_SPEED, MAX_ATTACK_SPEED, DEFAULT_WEAPON_SPEED } from './combat/AnimSpeed.js';
export {
  getMaxMissileRange, MISSILE_RANGE_CAP, DEFAULT_MAX_VELOCITY, METERS_TO_YARDS,
  getProjectileSpeed, missileAimDivisor, missileArcGroundReach, missileShot, MISSILE_GRAVITY, PROJ_SPAWN_HEIGHT, FAST_MISSILE_MODIFIER, PHYSICS_MAX_VELOCITY,
  DEFAULT_PROJECTILE_RADIUS, solveBallisticArc, missileAimLevelDeg, missileArc, missileArcPoint,
  SPELL_PROJ_HEIGHT, SPELL_PROJ_CLOSE_CYL_DIST, cylinderDistance, boltLaunch,
} from './combat/MissileRange.js';
export type { MissileShot, MissileArc, BoltLaunch } from './combat/MissileRange.js';
export { isAmmoLauncherCombatStyle, canFireMissile } from './combat/MissileAmmo.js';
export { canAttackTarget } from './combat/AttackTargetGate.js';
export { canUseTarget, targetResolves, type TargetLocations } from './systems/UseTargetGate.js';
export { canAddToTrade } from './systems/TradeGate.js';
export { canOpenTrade, isTradeUse, attemptToOpenTradeNegotiations, PEACE_MODE_TO_TRADE_TEXT } from './systems/OpenTradeGate.js';
export { resolveAllegianceInfoQuery, isAllegianceRecordOnline, resolveAllegiancePatron, allegianceInfoLines, allegianceFullName } from './systems/AllegianceInfoQuery.js';
export type { AllegianceInfoRecord, AllegianceInfoQueryResult, AllegianceMemberRecord } from './systems/AllegianceInfoQuery.js';
export {
  resolveLoginPositionRestore,
  POSTYPE_LAST_OUTSIDE_DEATH,
} from './systems/LoginPositionRestore.js';
export type { LoginPosition, LoginPositionRestoreAction } from './systems/LoginPositionRestore.js';
export {
  isTieSpell, isTieBindConfirmationText, resolveTieBindConfirmation,
  SPELLID_PORTAL_TIE1, SPELLID_LIFESTONE_TIE1, SPELLID_PORTAL_TIE2,
  LIFESTONE_TIE_CONFIRM_TEXT, PORTAL_TIE_CONFIRM_TEXT,
} from './systems/TieBindResolver.js';
export type { PendingTieBind, TieBindPosition, TieBindAction } from './systems/TieBindResolver.js';
export {
  targetAcquiredDecision, manaStoneConfirmText, salvageConfirmText, itemListDropSlot,
  MANA_STONE_RETAINED_REFUSAL, ITEM_TYPE_MANASTONE, ITEM_TYPE_TINKERING_MATERIAL, UI_EFFECT_MAGICAL, OBJECT_DESC_RETAINED,
} from './systems/TargetAcquired.js';
export type { TargetAcquiredDecision, TargetAcquiredSource, TargetAcquiredTarget } from './systems/TargetAcquired.js';
export {
  resolveCombatManeuverTableDid, DEFAULT_COMBAT_TABLE_DID,
} from './combat/CombatManeuverTableSelection.js';
export { AttackConditions } from './combat/AttackConditions.js';
export {
  DamageLocation, damageLocationLabel, combatSeverityTier, combatVerb,
  formatAttackerChat, formatDefenderChat, formatDefenderNotificationLog,
} from './combat/CombatDialog.js';

// Magic (Phase 24)
export { MagicSchool, MetaSpellType, SpellTargetType } from './magic/SpellEngine.js';
export type { SpellDefinition } from './magic/SpellEngine.js';
export { magicSchoolColor, magicSchoolColorNum, magicSchoolEmissiveNum, magicSchoolColorRGBA, magicSchoolName } from './magic/MagicSchoolColors.js';
export { EnchantmentManager, EnchantmentCategory, EnchantmentStatDomain, PERMANENT_ENCHANTMENT_DURATION, StatModType, VITAE_SPELL_ID } from './magic/EnchantmentManager.js';
export type { ActiveEnchantment, EnchantmentTick, EnchantmentRegistryEntry } from './magic/EnchantmentManager.js';
export { PropertyAttribute } from './magic/SpellApplication.js';
export { ProjectileSpellType } from './magic/SpellProjectile.js';
export {
  Scarab, ComponentType, MIN_POWER_BY_LEVEL, MAX_SPELL_LEVEL, spellLevelFromPower, isScarab,
  computeAccountHash, getPlayerFormula, getCastGestureSequence,
} from './magic/SpellFormula.js';
export type { SpellComponentGestureInfo } from './magic/SpellFormula.js';
export { SPELL_FLAG_SELF_TARGETED, resolveCastTarget, targetTypeFromComponentId, spellFormulaTargetingType, inqSpellTargetType } from './magic/CastTargeting.js';
export type { CastTargetResolution } from './magic/CastTargeting.js';
export { SPELL_COMPONENT_DID_MAPPER_ID, SPELL_COMPONENTS_MISSING_TEXT, spellComponentsSatisfied, appropriateSpellFormula, scarabOnlyFormula, componentPowerLevel, INFUSED_MAGIC_AUGMENTATION_INT, PRISMATIC_TAPER_COMPONENT_ID } from './magic/SpellComponentCheck.js';

// Loot materials (Phase 27)
export { MaterialType, MATERIAL_NAMES, getMaterialName } from './loot/MaterialTypes.js';

// Vitae (Phase 28)
export { VitaeSystem, vitaeCpPoolThreshold } from './systems/DeathSystem.js';

// Vendors (Phase 29)
export { vendorSellRejectionReason } from './npc/VendorSystem.js';
export type { VendorItem, VendorConfig } from './npc/VendorSystem.js';

// Allegiance (Phase 30)
export {
  HeritageGroup, MAX_RANK, HERITAGE_RANK_TITLES, getAllegianceRankTitle,
} from './social/AllegianceSystem.js';
export type { RankTitles } from './social/AllegianceSystem.js';

// Imbues (Phase 39)
export { ImbuedEffectType, imbuedEffectsLabels } from './crafting/TinkeringSystem.js';

// Housing (Phase 40)
export { HouseType, houseTypeName } from './housing/HousingTypes.js';

// Enums
export { Sound } from './enums/Sound.js';
export {
  EnvironChangeType, ENVIRON_FOG, ENVIRON_SOUND, isEnvironFog, isEnvironSound,
} from './enums/EnvironChange.js';
export type { EnvironFog } from './enums/EnvironChange.js';
export { ChatMessageType, chatColorFor, resolveChatType, buildRetailChatColorTable, RETAIL_CHAT_COLORS, RETAIL_CHAT_TEXT_TYPE_COUNT, SquelchMask, squelchMaskForChatType } from './enums/ChatMessageType.js';
export { PlayScript } from './enums/PlayScript.js';
export { playScript1999ToEoL, playScriptEoLTo1999, PLAYSCRIPT_EOL_ONLY_SKILLDOWNBLACK } from './enums/PlayScript1999.js';
export { MovementType } from './enums/MovementType.js';
export { ChessMoveType } from './enums/ChessMoveType.js';
export { ChessColor } from './enums/ChessColor.js';
export { ChessMoveResult, chessMoveResultText } from './enums/ChessMoveResult.js';
export { EndTradeReason } from './enums/EndTradeReason.js';
export { PlayerKillerStatus, playerKillerStatusLabel, playerKillerAssessLabel } from './enums/PlayerKillerStatus.js';
export { TradeSide } from './enums/TradeSide.js';
export { FriendsUpdateType } from './enums/FriendsUpdateType.js';
export { FellowUpdateType } from './enums/FellowUpdateType.js';
export { RadarBehavior } from './enums/RadarBehavior.js';
export { CharacterOptionDataFlag } from './enums/CharacterOptionDataFlag.js';
export {
  CharacterGenerationVerificationResponse,
  characterCreateErrorToken,
} from './enums/CharacterGenerationVerificationResponse.js';
export {
  CharacterError,
  characterErrorMessage,
} from './enums/CharacterError.js';
export {
  CharacterTitle,
  titleDisplayName,
} from './enums/CharacterTitle.js';
export {
  SkillCategory,
  skillCategoryLabel,
  skillAdvancementClassLabel,
} from './enums/SkillCategory.js';
export { itemTypeLabel } from './enums/ItemTypeLabels.js';
export {
  ContractStage,
  CONTRACT_TEXT,
  contractProgressText,
  contractTimedText,
  contractRepeatLeft,
  sprintfOneInt,
  deltaTimeToString,
  type ContractTiming,
} from './enums/ContractStage.js';
export {
  roundHalfAwayFromZero,
  roundHalfToEven,
} from './util/round.js';
export { SELF_EMOTE_SPEAKER, substituteEmotePronoun, composeHeardEmoteLine, composeSelfEmoteLine, isOwnSoulEmoteEcho } from './emote-lines.js';
export * from './routines/index.js';
export * from './goarrow/index.js';
export * from './magtools/index.js';
export * from './vcs5/vcs5.js';
