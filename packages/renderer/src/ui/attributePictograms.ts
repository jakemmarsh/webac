/**
 * ASSESS: VISUAL.5 — the six attribute pictogram textures from portal.dat
 * (0x060002c4-0x060002c9, all 25x25 — the same size class as the shipped
 * vital hearts 0x06004c3b-3d). The old "not in portal.dat" blocker note was
 * refuted by the 2026-06-09 panel-spec sweep (full-DAT size scan); the
 * per-attribute assignment below was verified twice: side-by-side against
 * the retail icon column in reference/images/hud/character-panel-attributes.jpg
 * (spec: verification/panel-specs/char-skills+attributes.md), and again
 * 2026-06-10 by decoding each texture from our portal.dat and matching its
 * art (Strength = flexing figure, Endurance = purple crowd, Coordination =
 * juggler with blue drops, Quickness = diagonal motion blur, Focus =
 * crouched aimer under a purple droplet, Self = radiant glowing bust).
 *
 * Keys match GameUI's ATTRIBUTE_NAMES / CharacterInfo.attributes keys.
 */
export const ATTRIBUTE_PICTOGRAM_TEXTURES: Record<
  'strength' | 'endurance' | 'coordination' | 'quickness' | 'focus' | 'self',
  number
> = {
  strength: 0x060002c8,
  endurance: 0x060002c4,
  coordination: 0x060002c9,
  quickness: 0x060002c6,
  focus: 0x060002c5,
  self: 0x060002c7,
};

/** Expected pixel dimensions of every attribute pictogram (square). */
export const ATTRIBUTE_PICTOGRAM_SIZE = 25;
