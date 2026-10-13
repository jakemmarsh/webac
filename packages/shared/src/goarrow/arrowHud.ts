/**
 * The arrow HUD's pure rules (docs/plugin-specs/goarrow.md §1, §7): visibility, the text lines, colours,
 * frame sets and defaults. Drawing is the renderer's job; this is what it draws.
 */
import { formatGoCoords, formatGoDistance, goDistance, type GoCoords } from './coordinates.js';

/** An arrow image set (spec §1.1): frame 1 points dead ahead, frames advance clockwise. */
export interface GoArrowSet {
  name: string;
  frames: number;
  width: number;
  height: number;
}

/** The bundled sets (MIT art, spec §8), in the dropdown's case-insensitive order. */
export const GOARROW_ARROW_SETS: readonly GoArrowSet[] = [
  { name: 'Chrome', frames: 180, width: 69, height: 71 },
  { name: 'Red Glass', frames: 90, width: 69, height: 71 },
  { name: 'Silver Arrowhead', frames: 90, width: 72, height: 71 },
  { name: 'Silver Pointer', frames: 71, width: 62, height: 63 },
  { name: 'Simple', frames: 1, width: 48, height: 48 },
];
export const GOARROW_DEFAULT_ARROW_SET = 'Chrome';

/** The saved set name, else `Chrome`, else the first available; null when none loaded (spec §1.1). */
export function goPickArrowSet(saved: string | null | undefined, available: readonly string[]): string | null {
  const find = (n: string) => available.find((a) => a.toLowerCase() === n.toLowerCase());
  return (saved ? find(saved) : undefined) ?? find(GOARROW_DEFAULT_ARROW_SET) ?? available[0] ?? null;
}
export const GOARROW_NO_ARROW_IMAGE_MESSAGE = 'Could not load any arrow image. You should reinstall GoArrow.';
export const goArrowMissingMessage = (name: string): string => `Arrow '${name}' does not exist.`;

/** "Text color" choices (spec §1.3): label → 0xRRGGBB. */
export const GOARROW_TEXT_COLORS: ReadonlyArray<{ label: string; rgb: number }> = [
  { label: 'White', rgb: 0xffffff },
  { label: 'Black', rgb: 0x000000 },
  { label: 'Blue', rgb: 0x4169ff },
  { label: 'Gold', rgb: 0xffd700 },
  { label: 'Green', rgb: 0x90ee90 },
  // The source's literal is the seven-digit "FFA06B4"; read as an int its low 24 bits are FA06B4.
  { label: 'Pink', rgb: 0xfa06b4 },
  { label: 'Red', rgb: 0xff0000 },
  { label: 'Yellow', rgb: 0xffff00 },
];

/**
 * The text outline (spec §1.3): 8 offset copies, the 4 orthogonal ones "solid", the 4 diagonal "light".
 * Only pure black text counts as dark and gets a white outline. Colours are [r, g, b, alpha 0–255].
 */
export function goArrowOutline(textRgb: number): { solid: [number, number, number, number]; light: [number, number, number, number] } {
  if ((textRgb & 0xffffff) === 0) return { solid: [255, 255, 255, 230], light: [255, 255, 255, 128] };
  return { solid: [0, 0, 0, 255], light: [0, 0, 0, 128] };
}
/** [dx, dy, which] for the 8 outline copies. */
export const GOARROW_OUTLINE_OFFSETS: ReadonlyArray<[number, number, 'solid' | 'light']> = [
  [-1, 0, 'solid'], [1, 0, 'solid'], [0, -1, 'solid'], [0, 1, 'solid'],
  [-1, -1, 'light'], [1, -1, 'light'], [-1, 1, 'light'], [1, 1, 'light'],
];

/** Canvas and layout constants (spec §1.3, §1.4). */
export const GOARROW_HUD_WIDTH = 400;
export const GOARROW_HUD_HEIGHT = 175;
export const GOARROW_HUD_DEFAULT_POSITION = { x: 100, y: 100 } as const;
export const GOARROW_TEXT_SIZE_MIN = 8;
export const GOARROW_TEXT_SIZE_MAX = 28;
/** The hover border colour (Gold) and the close box's size and inset. */
export const GOARROW_HOVER_BORDER_RGB = 0xffd700;
export const GOARROW_CLOSE_BOX_SIZE = 14;
export const GOARROW_CLOSE_BOX_INSET = 2;
/** A click on the outer 20% of the name line's text steps the route (spec §1.4). */
export const GOARROW_ROUTE_STEP_ZONE = 0.2;

/** The arrow image's top-left inside the 400 px canvas (spec §1.3). */
export function goArrowImageOrigin(imageWidth: number, textSize: number, showDestination: boolean): { x: number; y: number } {
  return { x: Math.floor((GOARROW_HUD_WIDTH - imageWidth) / 2), y: 1 + (showDestination ? 2 * textSize : 0) };
}

/** Which side of the name line a click at `x` (0 = the text's left edge, `width` = its right) lands on. */
export function goRouteStepClick(x: number, width: number): -1 | 0 | 1 {
  if (width <= 0) return 0;
  if (x >= 0 && x <= width * GOARROW_ROUTE_STEP_ZONE) return -1;
  if (x <= width && x >= width * (1 - GOARROW_ROUTE_STEP_ZONE)) return 1;
  return 0;
}

/**
 * "In a dungeon" (spec §1.5): an interior cell (low word ≥ 0x0100) whose EnvCell is NOT SeenOutside.
 * Building interiors are not dungeons for this rule. `seenOutside` is the EnvCell's flag 0x01.
 */
export function goArrowInDungeon(cellId: number, seenOutside: boolean): boolean {
  return (cellId & 0xffff) >= 0x0100 && !seenOutside;
}

/** Whether the arrow draws (spec §1.5). */
export function goArrowVisible(o: { enabled: boolean; hasImage: boolean; inDungeon: boolean; showIndoors: boolean }): boolean {
  return o.enabled && o.hasImage && (!o.inDungeon || o.showIndoors);
}
export const GOARROW_HIDDEN_INDOORS_MESSAGE = 'The arrow is enabled, but not visible because you are indoors';
export const GOARROW_HIDDEN_ERROR_MESSAGE = 'The arrow is enabled, but not visible (possibly because of an error loading the image file)';
export const GOARROW_RESET_POSITION_MESSAGE = 'The arrow should now be in a visible location on the screen';
export const GOARROW_TEXT_SIZE_RANGE_MESSAGE = 'Text size must be between 8 and 28';
export const GOARROW_TEXT_SIZE_NUMBER_MESSAGE = 'Text size must be a number';

/** What the arrow points at (spec §1.6). */
export type GoArrowTarget =
  | { kind: 'coords'; coords: GoCoords }
  | { kind: 'location'; name: string; coords: GoCoords | null }
  | { kind: 'route'; names: readonly string[]; coords: ReadonlyArray<GoCoords | null>; index: number }
  | { kind: 'object'; name: string; coords: GoCoords | null; inRange: boolean };

/** The target's coordinates, or null when unknown. */
export function goArrowTargetCoords(t: GoArrowTarget | null): GoCoords | null {
  if (!t) return null;
  if (t.kind === 'route') return t.coords[t.index] ?? null;
  return t.coords;
}

/** The name line (spec §1.3), or null when there is none (bare coordinates). */
export function goArrowNameLine(t: GoArrowTarget | null): string | null {
  if (!t || t.kind === 'coords') return null;
  if (t.kind === 'location') return t.name;
  if (t.kind === 'object') return t.inRange ? t.name : `${t.name} (out of range)`;
  const name = t.names[t.index] ?? '';
  return `${t.index > 0 ? '◄  ' : ''}${name}${t.index < t.names.length - 1 ? '  ►' : ''}`;
}

/**
 * The HUD's text lines, top to bottom (spec §1.3): the name line and the coordinates line when "Show
 * destination over arrow" is on, the distance line (under the image) when "Show distance under arrow" is.
 */
export function goArrowTextLines(t: GoArrowTarget | null, player: GoCoords | null, o: { showDestination: boolean; showDistance: boolean }): {
  name: string | null;
  coords: string | null;
  distance: string | null;
} {
  const dest = goArrowTargetCoords(t);
  return {
    name: o.showDestination ? goArrowNameLine(t) : null,
    coords: o.showDestination ? formatGoCoords(dest) : null,
    distance: o.showDistance ? formatGoDistance(goDistance(player, dest)) : null,
  };
}

/** The corpse-tracking location (spec §1.6). `shortTime` / `date` / `time` are preformatted by the caller. */
export function goCorpseLocation(o: { name: string; shortTime: string; date: string; time: string; deathMessage: string; dungeon?: string | null; coords: GoCoords }): {
  name: string;
  notes: string;
  icon: number;
  coords: GoCoords;
} {
  return {
    name: `Corpse of ${o.name} [${o.shortTime}]${o.dungeon ? ` in ${o.dungeon}` : ''}`,
    notes: `Corpse of ${o.name}\n${o.date} ${o.time}\n${o.deathMessage}${o.dungeon ? `\nIn Dungeon: ${o.dungeon}` : ''}`,
    icon: 0x06001070,
    coords: o.coords,
  };
}

/** Saved options and their defaults (spec §7). */
export interface GoArrowSettings {
  visible: boolean;
  location: { x: number; y: number };
  displayIndoors: boolean;
  showDestinationOver: boolean;
  showDistanceUnder: boolean;
  positionLocked: boolean;
  arrowName: string;
  textSize: number;
  textColor: number;
  textBold: boolean;
  trackCorpses: boolean;
  maxRunDistance: number;
  portalRunDistance: number;
  autoUpdateRecalls: boolean;
  autoDetectPortalDevices: boolean;
  linkCoords: boolean;
  chatCommand: string;
  locAlias: { enabled: boolean; name: string };
  destAlias: { enabled: boolean; name: string };
  findAlias: { enabled: boolean; name: string };
}

export const GOARROW_DEFAULT_SETTINGS: Readonly<GoArrowSettings> = Object.freeze({
  visible: false,
  location: { ...GOARROW_HUD_DEFAULT_POSITION },
  displayIndoors: false,
  showDestinationOver: true,
  showDistanceUnder: true,
  positionLocked: true,
  arrowName: GOARROW_DEFAULT_ARROW_SET,
  textSize: 14,
  textColor: 0xffffff,
  textBold: true,
  trackCorpses: true,
  maxRunDistance: 50,
  // GoArrow's route finder starts at 0 until a setting loads; the UI shows 0.4. We use 0.4 everywhere.
  portalRunDistance: 0.4,
  autoUpdateRecalls: true,
  autoDetectPortalDevices: true,
  linkCoords: true,
  chatCommand: 'goarrow',
  locAlias: { enabled: false, name: 'loc' },
  destAlias: { enabled: false, name: 'dest' },
  findAlias: { enabled: false, name: 'find' },
});

/** Clamp a "Text size" edit (spec §2.2); null with the message when invalid. */
export function goParseTextSize(text: string): { size: number } | { error: string } {
  const n = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(n) || !Number.isInteger(n)) return { error: GOARROW_TEXT_SIZE_NUMBER_MESSAGE };
  if (n < GOARROW_TEXT_SIZE_MIN || n > GOARROW_TEXT_SIZE_MAX) return { error: GOARROW_TEXT_SIZE_RANGE_MESSAGE };
  return { size: n };
}
