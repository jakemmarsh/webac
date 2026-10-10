/**
 * CharacterOptionDataFlag — bitfield gating optional sections of the
 * SetCharacterOptions C2S GameAction payload. The flags word is the first
 * uint32 of the payload; for each set bit, the corresponding sub-block is
 * emitted after the fixed prefix (options1 + numTab1Spells + spell lists).
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/CharacterOptionDataFlag.cs
 *
 *   Shortcut                    = 0x00000001
 *   SquelchList                 = 0x00000002
 *   MultiSpellList              = 0x00000004
 *   DesiredComps                = 0x00000008
 *   ExtendedMultiSpellLists     = 0x00000010
 *   SpellbookFilters            = 0x00000020
 *   CharacterOptions2           = 0x00000040
 *   TimestampFormat             = 0x00000080
 *   GenericQualitiesData        = 0x00000100
 *   GameplayOptions             = 0x00000200
 *   SpellLists8                 = 0x00000400
 *
 * ACE attribution: "Thanks to tfarley (aclogview) for these enums" — these
 * are the original Turbine client's wire-format flags reverse-engineered
 * from packet captures.
 */
export enum CharacterOptionDataFlag {
  Shortcut                = 0x00000001,
  SquelchList             = 0x00000002,
  MultiSpellList          = 0x00000004,
  DesiredComps            = 0x00000008,
  ExtendedMultiSpellLists = 0x00000010,
  SpellbookFilters        = 0x00000020,
  CharacterOptions2       = 0x00000040,
  TimestampFormat         = 0x00000080,
  GenericQualitiesData    = 0x00000100,
  GameplayOptions         = 0x00000200,
  SpellLists8             = 0x00000400,
}
