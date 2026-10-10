export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  w: number;
  x: number;
  y: number;
  z: number;
}

export interface Position {
  objCellId: number;
  origin: Vector3;
  rotation: Quaternion;
}

export interface Frame {
  origin: Vector3;
  rotation: Quaternion;
}

/**
 * Test whether a cell index (low 16 bits of a landblock-ID) refers to an
 * interior EnvCell — i.e. the object is inside a building, dungeon, or
 * other indoor area.
 *
 * Bounds per the cell.dat format (cf. CLAUDE.md "File Type ID Ranges"):
 *   • 0x0001-0xFFFD = EnvCell (interior cell)
 *   • 0xFFFE        = LandBlockInfo (outdoor building/decoration metadata)
 *   • 0xFFFF        = LandBlock (terrain mesh)
 *
 * ACE.Entity.LandblockId defines `Indoors => (Raw & 0xFFFF) >= 0x100`
 * (no upper bound) because in ACE's internal representation the cell
 * index 0xFFFE/0xFFFF never appears in `Position.landblockId`. On the
 * wire the client routinely receives full landblock IDs like
 * `0xXXYY**FFFF**` (terrain), so the upper bound 0xFFFE protects against
 * mis-classifying terrain-pose positions as interior cells.
 *
 * Lower bound 0x100 matches ACE — cell indices below 0x100 are the 8×8
 * outdoor sub-cells, not true interior cells.
 *
 * Pass the masked cell index (`landblock & 0xFFFF`), NOT the full
 * 32-bit landblock ID.
 */
export function isInteriorCellIndex(cellIndex: number): boolean {
  return cellIndex >= 0x0100 && cellIndex < 0xFFFE;
}

/**
 * Decode the X coordinate (0-255) of a landblock from a packed landblock ID.
 *
 * Wire format (per ACE.Entity.LandblockId): the 32-bit `landblockId` packs
 * `(blockX << 24) | (blockY << 16) | cellIndex`. This helper extracts the
 * high byte. Use `landblockY` for the second byte and `cellIndexOf` for
 * the low 16 bits.
 */
export function landblockX(landblockId: number): number {
  return (landblockId >>> 24) & 0xFF;
}

/**
 * Decode the Y coordinate (0-255) of a landblock from a packed landblock ID.
 * See `landblockX` for the packing format.
 */
export function landblockY(landblockId: number): number {
  return (landblockId >>> 16) & 0xFF;
}

/**
 * Extract the cell index (low 16 bits) of a packed landblock/cell ID.
 *   • 0xFFFF        = the outdoor terrain cell of the landblock
 *   • 0xFFFE        = LandBlockInfo (building/decoration metadata)
 *   • 0x0100-0xFFFD = an EnvCell (interior — see `isInteriorCellIndex`)
 *   • 0x0001-0x00FF = an outdoor 24m × 24m sub-cell
 */
export function cellIndexOf(landblockId: number): number {
  return landblockId & 0xFFFF;
}

/**
 * Format world coordinates as the AC retail map-coord string
 * (e.g. `"42.1N, 33.6E"`).
 *
 * Source: `reference/ACE/Source/ACE.Server/Entity/PositionExtensions.cs:204-238`
 * (`GetMapCoords` + `GetMapCoordStr`). Conversion:
 *   • 1 landblock = 192 meters = 0.8 map units, so 1 map unit = 240 meters.
 *   • Dereth is 204 map units across, with center at (0, 0): subtract 102.
 *   • Sign of Y selects N/S, sign of X selects E/W.
 *   • Print 1-decimal absolute values minus a `0.05` rounding bias to match
 *     the retail client's rounding (`{abs - 0.05:0.0}`).
 *
 * `worldX` and `worldZ` are in meters (Three.js world space — X east, Z north).
 * Returns `null` for indoor/dungeon cells (caller-supplied flag).
 *
 * Use cases:
 *   • HUD coord readout (matches what AC retail showed under the radar).
 *   • `/loc` and `/corpse` chat commands.
 *   • Re-rendering server-sent `Your corpse is located at (...)` messages
 *     (Creature_Death.cs:562) from cached PositionType.LastOutsideDeath.
 */
/**
 * Player GUID range — anchored to ACE.Entity.ObjectGuid.cs:21-22 + :36.
 *   `public static uint PlayerMin { get; } = 0x50000001;`
 *   `public static uint PlayerMax { get; } = 0x5FFFFFFF;`
 *   `public static bool IsPlayer(uint guid) { return guid >= PlayerMin && guid <= PlayerMax; }`
 *
 * The original AC client uses this range to distinguish PCs from creatures,
 * statics, dynamics, etc. Used client-side to pre-validate targets for
 * actions that ACE silently rejects when the target isn't a Player (e.g.
 * Player_Allegiance.cs:70 HandleActionSwearAllegiance:
 * `if (patron == null) return;` — `patron = PlayerManager.GetOnlinePlayer(guid)`
 * which returns null for non-Players, yielding no feedback to the player).
 */
export const PLAYER_GUID_MIN = 0x50000001;
export const PLAYER_GUID_MAX = 0x5fffffff;
export function isPlayerGuid(guid: number): boolean {
  return guid >= PLAYER_GUID_MIN && guid <= PLAYER_GUID_MAX;
}

// ACE PositionExtensions.GetMapCoordStr (PositionExtensions.cs:226) — the
// SERVER's formula: global / 240 − 102, then |v| − 0.05 to one decimal.
// Use it only where the text must match what ACE itself prints (/loc,
// "Your corpse is located at (...)", contract locations). The retail
// client's own readouts — the radar strip, the map line, the journal —
// use CPlayerSystem::InqPlayerCoords' cell-quantized (c − 1024) × 0.1 + 0.5
// instead (renderer ui/MapMarkers.ts radarCoordinateReadout); the two can
// differ by 0.1 (Holtburg: 42.0N, 33.5E here vs 42.1N, 33.6E there).
export function formatMapCoordParts(worldX: number, worldZ: number): { ns: string; ew: string } {
  // 240 m per map unit, center at (0,0) after the -102 shift.
  const mapX = worldX / 240 - 102;
  const mapZ = worldZ / 240 - 102;
  const ns = mapZ >= 0 ? 'N' : 'S';
  const ew = mapX >= 0 ? 'E' : 'W';
  // ACE applies a 0.05 rounding bias before truncating to 1 decimal.
  const nsVal = Math.max(0, Math.abs(mapZ) - 0.05).toFixed(1);
  const ewVal = Math.max(0, Math.abs(mapX) - 0.05).toFixed(1);
  return { ns: `${nsVal}${ns}`, ew: `${ewVal}${ew}` };
}

export function formatMapCoord(worldX: number, worldZ: number): string {
  const { ns, ew } = formatMapCoordParts(worldX, worldZ);
  return `${ns}, ${ew}`;
}
