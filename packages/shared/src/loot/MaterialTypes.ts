/**
 * MaterialTypes — the MaterialType enum and its display names.
 *
 * Loot material selection and value modifiers are server-authoritative
 * (ACE.Server/Factories/LootGenerationFactory*.cs); the client only names
 * the material ids the server sends.
 */

// ─── Material Type Enum ─────────────────────────────────────

/**
 * MaterialType — numeric IDs MUST match ACE.Entity.Enum.MaterialType.cs exactly.
 * The server sends these IDs on the wire (in IdentifyResponse, GameEventSalvageOperationsResult,
 * etc.), so any divergence here means we mislabel the player's items.
 *
 * Anchored against reference/ACE/Source/ACE.Entity/Enum/MaterialType.cs.
 */
export enum MaterialType {
  Unknown = 0x00,
  // Ceramics
  Ceramic = 0x01, Porcelain = 0x02,
  // Cloth (Cloth=0x03 is the category, individual fabrics are 0x04-0x08)
  Cloth = 0x03, Linen = 0x04, Satin = 0x05, Silk = 0x06, Velvet = 0x07, Wool = 0x08,
  // Gems (Gem=0x09 is the category)
  Gem = 0x09,
  Agate = 0x0A, Amber = 0x0B, Amethyst = 0x0C, Aquamarine = 0x0D,
  Azurite = 0x0E, BlackGarnet = 0x0F, BlackOpal = 0x10, Bloodstone = 0x11,
  Carnelian = 0x12, Citrine = 0x13, Diamond = 0x14,
  Emerald = 0x15, FireOpal = 0x16, GreenGarnet = 0x17,
  GreenJade = 0x18, Hematite = 0x19, ImperialTopaz = 0x1A,
  Jet = 0x1B, LapisLazuli = 0x1C, LavenderJade = 0x1D,
  Malachite = 0x1E, Moonstone = 0x1F, Onyx = 0x20,
  Opal = 0x21, Peridot = 0x22, RedGarnet = 0x23,
  RedJade = 0x24, RoseQuartz = 0x25, Ruby = 0x26,
  Sapphire = 0x27, SmokeyQuartz = 0x28, Sunstone = 0x29,
  TigerEye = 0x2A, Tourmaline = 0x2B, Turquoise = 0x2C,
  WhiteJade = 0x2D, WhiteQuartz = 0x2E, WhiteSapphire = 0x2F,
  YellowGarnet = 0x30, YellowTopaz = 0x31, Zircon = 0x32,
  // Ivory
  Ivory = 0x33,
  // Leathers
  Leather = 0x34, ArmoredilloHide = 0x35, GromnieHide = 0x36, ReedSharkHide = 0x37,
  // Metals (Metal=0x38 is the category)
  Metal = 0x38, Brass = 0x39, Bronze = 0x3A, Copper = 0x3B, Gold = 0x3C,
  Iron = 0x3D, Pyreal = 0x3E, Silver = 0x3F, Steel = 0x40,
  // Stone (Stone=0x41 is the category)
  Stone = 0x41, Alabaster = 0x42, Granite = 0x43, Marble = 0x44, Obsidian = 0x45, Sandstone = 0x46, Serpentine = 0x47,
  // Wood (Wood=0x48 is the category)
  Wood = 0x48, Ebony = 0x49, Mahogany = 0x4A, Oak = 0x4B, Pine = 0x4C, Teak = 0x4D,
}

/**
 * Material display names — these are the strings the AC client shows in tooltips
 * and salvage results. Source: ACE MaterialType enum identifier names with
 * CamelCase split into spaces ("BlackGarnet" → "Black Garnet").
 */
export const MATERIAL_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [MaterialType.Unknown]: 'Unknown',
  [MaterialType.Ceramic]: 'Ceramic', [MaterialType.Porcelain]: 'Porcelain',
  [MaterialType.Cloth]: 'Cloth', [MaterialType.Linen]: 'Linen',
  [MaterialType.Satin]: 'Satin', [MaterialType.Silk]: 'Silk',
  [MaterialType.Velvet]: 'Velvet', [MaterialType.Wool]: 'Wool',
  [MaterialType.Gem]: 'Gem',
  [MaterialType.Agate]: 'Agate', [MaterialType.Amber]: 'Amber',
  [MaterialType.Amethyst]: 'Amethyst', [MaterialType.Aquamarine]: 'Aquamarine',
  [MaterialType.Azurite]: 'Azurite', [MaterialType.BlackGarnet]: 'Black Garnet',
  [MaterialType.BlackOpal]: 'Black Opal', [MaterialType.Bloodstone]: 'Bloodstone',
  [MaterialType.Carnelian]: 'Carnelian', [MaterialType.Citrine]: 'Citrine',
  [MaterialType.Diamond]: 'Diamond', [MaterialType.Emerald]: 'Emerald',
  [MaterialType.FireOpal]: 'Fire Opal', [MaterialType.GreenGarnet]: 'Green Garnet',
  [MaterialType.GreenJade]: 'Green Jade', [MaterialType.Hematite]: 'Hematite',
  [MaterialType.ImperialTopaz]: 'Imperial Topaz', [MaterialType.Jet]: 'Jet',
  [MaterialType.LapisLazuli]: 'Lapis Lazuli', [MaterialType.LavenderJade]: 'Lavender Jade',
  [MaterialType.Malachite]: 'Malachite', [MaterialType.Moonstone]: 'Moonstone',
  [MaterialType.Onyx]: 'Onyx', [MaterialType.Opal]: 'Opal',
  [MaterialType.Peridot]: 'Peridot', [MaterialType.RedGarnet]: 'Red Garnet',
  [MaterialType.RedJade]: 'Red Jade', [MaterialType.RoseQuartz]: 'Rose Quartz',
  [MaterialType.Ruby]: 'Ruby', [MaterialType.Sapphire]: 'Sapphire',
  [MaterialType.SmokeyQuartz]: 'Smokey Quartz', [MaterialType.Sunstone]: 'Sunstone',
  [MaterialType.TigerEye]: 'Tiger Eye', [MaterialType.Tourmaline]: 'Tourmaline',
  [MaterialType.Turquoise]: 'Turquoise', [MaterialType.WhiteJade]: 'White Jade',
  [MaterialType.WhiteQuartz]: 'White Quartz', [MaterialType.WhiteSapphire]: 'White Sapphire',
  [MaterialType.YellowGarnet]: 'Yellow Garnet', [MaterialType.YellowTopaz]: 'Yellow Topaz',
  [MaterialType.Zircon]: 'Zircon',
  [MaterialType.Ivory]: 'Ivory',
  [MaterialType.Leather]: 'Leather', [MaterialType.ArmoredilloHide]: 'Armoredillo Hide',
  [MaterialType.GromnieHide]: 'Gromnie Hide', [MaterialType.ReedSharkHide]: 'Reed Shark Hide',
  [MaterialType.Metal]: 'Metal', [MaterialType.Brass]: 'Brass',
  [MaterialType.Bronze]: 'Bronze', [MaterialType.Copper]: 'Copper',
  [MaterialType.Gold]: 'Gold', [MaterialType.Iron]: 'Iron',
  [MaterialType.Pyreal]: 'Pyreal', [MaterialType.Silver]: 'Silver',
  [MaterialType.Steel]: 'Steel',
  [MaterialType.Stone]: 'Stone', [MaterialType.Alabaster]: 'Alabaster',
  [MaterialType.Granite]: 'Granite', [MaterialType.Marble]: 'Marble',
  [MaterialType.Obsidian]: 'Obsidian', [MaterialType.Sandstone]: 'Sandstone',
  [MaterialType.Serpentine]: 'Serpentine',
  [MaterialType.Wood]: 'Wood', [MaterialType.Ebony]: 'Ebony',
  [MaterialType.Mahogany]: 'Mahogany', [MaterialType.Oak]: 'Oak',
  [MaterialType.Pine]: 'Pine', [MaterialType.Teak]: 'Teak',
});

/** Look up a material's display name from its ACE numeric ID. */
export function getMaterialName(materialType: number): string {
  return MATERIAL_NAMES[materialType] ?? `Material ${materialType}`;
}
