/**
 * Radar compass letter tokens — CORE.5.e, re-derived for the EoL floaty
 * radar in CORE.5.b.b.
 *
 * Retail draws the N/E/S/W compass letters as four 10x9 DAT letter textures
 * riding the radar ring band, repositioned (never rotated) around the dial
 * center as the player turns. Ground truth (EoL floaty radar — the family
 * the end-of-retail root HUD 0x21000005 actually builds, child 0x100006d2
 * at (680,0) 120x140):
 *
 * - DAT: layout 0x21000074, radar root 0x100006d3 (120x140, disc texture
 *   0x06004cc1 at (0,0) 120x120) authors the tokens as children:
 *     N 0x10000040 (55,1)   tex 0x060011fb (green-tinted glyph)
 *     E 0x10000041 (110,55) tex 0x06001938
 *     S 0x10000042 (55,110) tex 0x0600193a
 *     W 0x10000043 (0,55)   tex 0x0600193c
 *   The root's dial-center attribute 0x1000002E is the struct
 *   {0x1000002F: 60, 0x10000030: 60}; dial radius attr 0x1000002D = 50.
 *   (The classic 300x120 ornate radar 0x21000017 authors the same tokens
 *   and textures at its own geometry with dial center (148,60) — replaced
 *   by this family per the EoL root HUD.)
 *
 * - Decompiled client: gmRadarUI::PostInit @ 004d9d30 resolves each token via
 *   attributes 0x10000031 (N) / 0x10000033 (E) / 0x10000032 (S) / 0x10000034
 *   (W) and stores a per-token magnitude = distance from the dial center to
 *   the token's authored center (position + size*0.5).
 *   gmRadarUI::UpdateCompassTokens @ 004d9060 then, whenever the player
 *   heading changes, sets each token's position to
 *     x = center.x + sin(rad + offset) * magnitude - width/2
 *     y = center.y + cos(rad + offset) * magnitude - height/2
 *   with heading in radians and offsets N=pi, E=pi/2, S=0, W=3pi/2
 *   (float constants 400921fb54442d18 / 3fc90fdb / 4096cbe4 in the decompile),
 *   converted to int via _ftol2 (C truncation). The same gmRadarUI class
 *   serves both radar layouts — the math is identical, only the authored
 *   geometry differs.
 *
 * The letter textures are DXT1 with an opaque black background — retail
 * relies on the ring band under them being near-black, so no keying is
 * needed.
 */

export type CompassTokenKey = 'n' | 'e' | 's' | 'w';

export interface CompassTokenSpec {
  key: CompassTokenKey;
  /** portal.dat letter texture DID */
  textureId: number;
  /** authored position/size within radar root 0x100006d3 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** angle offset added to the player heading (radians) — UpdateCompassTokens */
  offset: number;
}

/** Dial center within radar root 0x100006d3 — attr struct 0x1000002E {60, 60}. */
export const RADAR_DIAL_CENTER = { x: 60, y: 60 } as const;

/** Dial radius — attr 0x1000002D on radar root 0x100006d3 (dot clip circle). */
export const RADAR_DIAL_RADIUS = 50;

export const RADAR_COMPASS_TOKENS: readonly CompassTokenSpec[] = [
  { key: 'n', textureId: 0x060011fb, x: 55, y: 1, w: 10, h: 9, offset: Math.PI },
  { key: 'e', textureId: 0x06001938, x: 110, y: 55, w: 10, h: 9, offset: Math.PI / 2 },
  { key: 's', textureId: 0x0600193a, x: 55, y: 110, w: 10, h: 9, offset: 0 },
  { key: 'w', textureId: 0x0600193c, x: 0, y: 55, w: 10, h: 9, offset: (3 * Math.PI) / 2 },
];

/** Retail PostInit magnitude: distance from dial center to the token's authored center. */
export function compassTokenMagnitude(t: CompassTokenSpec): number {
  const dx = RADAR_DIAL_CENTER.x - (t.x + t.w / 2);
  const dy = RADAR_DIAL_CENTER.y - (t.y + t.h / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Retail UpdateCompassTokens: top-left CSS position of each token within the
 * 120x140 radar root for the given player heading (degrees, 0 = north,
 * 90 = east). Truncation mirrors the client's _ftol2 int conversion.
 */
export function computeCompassTokenPositions(
  headingDegrees: number,
): Record<CompassTokenKey, { left: number; top: number }> {
  const rad = headingDegrees * (Math.PI / 180);
  const out = {} as Record<CompassTokenKey, { left: number; top: number }>;
  for (const t of RADAR_COMPASS_TOKENS) {
    const mag = compassTokenMagnitude(t);
    out[t.key] = {
      left: Math.trunc(RADAR_DIAL_CENTER.x + Math.sin(rad + t.offset) * mag - t.w / 2),
      top: Math.trunc(RADAR_DIAL_CENTER.y + Math.cos(rad + t.offset) * mag - t.h / 2),
    };
  }
  return out;
}
