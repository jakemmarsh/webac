/**
 * AGENT — where an object is NOW, for observations: the render position the
 * client moves every frame (its physics body: server positions plus the
 * motion it simulates in between), not the last UpdatePosition the server
 * sent. The server sends those rarely for a moving creature or player, so
 * reading them left other players hundreds of metres off and attackers
 * listed as 11–16 m away while hitting you (2026-10-09).
 *
 * World coordinates are global metres (landblock × 192 + local; Three.js X
 * east, Z north, Y up). An interior cell (index ≥ 0x100) keeps its cell (the
 * body's, kept current by the server's positions); outdoors the cell is
 * recomputed from the position (24 m cells: index = cellX × 8 + cellY + 1,
 * ACE LandblockId / the landblock's cell grid), since local motion can carry
 * a body across cells between server updates.
 */
export interface LivePlaceInput {
  worldX: number; worldY: number; worldZ: number;
  /** The physics body's cell, or the object's last cell. */
  cell: number | null | undefined;
  /** The object is placed in the world (drawn or simulated), not held, carried or out of the world. */
  placed: boolean;
  /**
   * Where the server last put it (ServerObject.serverPlace: cell + render-axis global metres), and whether
   * the physics body moved worldX/Y/Z in the last moment (`bodyLive`). A body nobody steps (its cell is not
   * loaded here, it has no mesh yet, the frame loop is stalled) stands where it was while the server moves
   * the creature on: four rats on another floor of A Rat Nest kept the same distances for ten minutes, and a
   * fellow by an indoor cell read 66–81 m off one second and 2 m the next (2026-10-10). Then the server's
   * last position is the better one.
   */
  server?: { cell: number; worldX: number; worldY: number; worldZ: number } | null;
  bodyLive?: boolean;
}

/** How recently the body must have moved the object for its position to be the live one, ms. */
export const BODY_LIVE_MS = 1500;

export function livePlace(o: LivePlaceInput): { cell: number; x: number; y: number; z: number } | null {
  if (!o.placed) return null;
  if (o.bodyLive === false && o.server && Number.isFinite(o.server.worldX) && Number.isFinite(o.server.worldZ)) {
    return livePlace({ worldX: o.server.worldX, worldY: o.server.worldY, worldZ: o.server.worldZ, cell: o.server.cell, placed: true });
  }
  if (!Number.isFinite(o.worldX) || !Number.isFinite(o.worldZ)) return null;
  const cell = (o.cell ?? 0) >>> 0;
  if (cell && (cell & 0xffff) >= 0x100) {
    const lbX = (cell >>> 24) & 0xff, lbY = (cell >>> 16) & 0xff;
    return { cell, x: o.worldX - lbX * 192, y: o.worldZ - lbY * 192, z: o.worldY };
  }
  const lbX = Math.floor(o.worldX / 192), lbY = Math.floor(o.worldZ / 192);
  if (lbX < 0 || lbX > 0xff || lbY < 0 || lbY > 0xff) return null;
  const x = o.worldX - lbX * 192, y = o.worldZ - lbY * 192;
  const index = Math.min(7, Math.floor(x / 24)) * 8 + Math.min(7, Math.floor(y / 24)) + 1;
  return { cell: ((lbX << 24) | (lbY << 16) | index) >>> 0, x, y, z: o.worldY };
}
