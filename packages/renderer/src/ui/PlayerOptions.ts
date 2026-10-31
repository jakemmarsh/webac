/**
 * Retail PlayerOption values by name (= ACE CharacterOption, the SetSingleCharacterOption code):
 * UB's `/ub playeroption` names, and the Keyboard Config's Character Settings commands
 * (EraFeatures.OPTION_KEYBIND_ACTIONS → ActionDispatch).
 */
export const PLAYER_OPTIONS: Readonly<Record<string, number>> = {
  AutoRepeatAttack: 0x00, IgnoreAllegianceRequests: 0x01, IgnoreFellowshipRequests: 0x02, IgnoreTradeRequests: 0x03,
  DisableMostWeatherEffects: 0x04, PersistentAtDay: 0x05, AllowGive: 0x06, ViewCombatTarget: 0x07, ShowTooltips: 0x08,
  UseDeception: 0x09, ToggleRun: 0x0a, StayInChatMode: 0x0b, AdvancedCombatUI: 0x0c, AutoTarget: 0x0d,
  VividTargetingIndicator: 0x0e, FellowshipShareXP: 0x0f, AcceptLootPermits: 0x10, FellowshipShareLoot: 0x11,
  FellowshipAutoAcceptRequests: 0x12, SideBySideVitals: 0x13, CoordinatesOnRadar: 0x14, SpellDuration: 0x15,
  DisableHouseRestrictionEffects: 0x16, DragItemOnPlayerOpensSecureTrade: 0x17, DisplayAllegianceLogonNotifications: 0x18,
  UseChargeAttack: 0x19, UseCraftSuccessDialog: 0x1a, HearAllegianceChat: 0x1b, DisplayDateOfBirth: 0x1c, DisplayAge: 0x1d,
  DisplayChessRank: 0x1e, DisplayFishingSkill: 0x1f, DisplayNumberDeaths: 0x20, DisplayTimeStamps: 0x21, SalvageMultiple: 0x22,
  HearGeneralChat: 0x23, HearTradeChat: 0x24, HearLFGChat: 0x25, HearRoleplayChat: 0x26, AppearOffline: 0x27,
  DisplayNumberCharacterTitles: 0x28, MainPackPreferred: 0x29, LeadMissileTargets: 0x2a, UseFastMissiles: 0x2b,
  FilterLanguage: 0x2c, ConfirmVolatileRareUse: 0x2d, HearSocietyChat: 0x2e, ShowHelm: 0x2f, DisableDistanceFog: 0x30,
  UseMouseTurning: 0x31, ShowCloak: 0x32, LockUI: 0x33, HearPKDeath: 0x34,
};
