/**
 * Map coordinates as players type them: "42.1N, 33.6E", "42.1N 33.6E", "42.1n33.6e", "42.1 N ; 33.6 W",
 * "42.1N/33.6E", ".5S, 3E", "42.1 North 33.6 East". North / east positive. One reader for the agent's walk_to,
 * the routine documents (validateRoutine, vtankExport) and the stream tools, so a form one accepts no other refuses.
 *
 * "walk_to target=\"42.6N 33.6E\"" (no comma) was read correctly all along (the stream's 2026-10-18 10:05Z walk set off
 * north for it); the readers differed only at the edges: the walk's and the routine's needed a comma or a space between
 * the two halves, so "42.6N33.6E" or "42.6N;33.6E" fell through to a name search, and the CLI's own check took
 * "N 33.6E" as enough.
 */

/** A coordinate number: 42, 42.1, .5 (GoArrow's bare fraction). */
const NUM = String.raw`(\d{1,3}(?:\.\d+)?|\.\d+)`;
/** The two halves: a number and N/S, then up to a few separators (comma, semicolon, slash, spaces), a number and E/W. */
export const MAP_COORDS_SOURCE = String.raw`${NUM}\s*(n(?:orth)?|s(?:outh)?)(?![a-z])[\s,;/]*${NUM}\s*(e(?:ast)?|w(?:est)?)(?![a-z])`;

export interface MapCoordsText { ns: number; ew: number }

function toCoords(m: RegExpExecArray): MapCoordsText {
  const ns = Number(m[1]!.startsWith('.') ? `0${m[1]}` : m[1]);
  const ew = Number(m[3]!.startsWith('.') ? `0${m[3]}` : m[3]);
  return { ns: /^s/i.test(m[2]!) ? -ns : ns, ew: /^w/i.test(m[4]!) ? -ew : ew };
}

/** The first coordinates anywhere in `text` (not glued to a word or number before them), or null. */
export function parseMapCoordsText(text: string): MapCoordsText | null {
  const m = new RegExp(String.raw`(?<![\w.])${MAP_COORDS_SOURCE}`, 'i').exec(text);
  return m ? toCoords(m) : null;
}

/** Whether the whole of `text` is map coordinates (and nothing else but spaces). */
export function isMapCoordsText(text: string): boolean {
  return new RegExp(String.raw`^\s*${MAP_COORDS_SOURCE}\s*$`, 'i').test(text);
}

/**
 * Text that reads as map coordinates with a half missing or garbled ("42.6N", "42.6N 33.6", "33.6E", "42.6N 33.6Q"):
 * not a name, and no place to walk to. A target like this is refused, never guessed at.
 */
export function isPartialMapCoordsText(text: string): boolean {
  if (isMapCoordsText(text)) return false;
  return /^\s*(\d{1,3}(?:\.\d+)?|\.\d+)\s*[nsew](?![a-z])[\s,;/]*((\d{1,3}(?:\.\d+)?|\.\d+)\s*[a-z]?)?\s*$/i.test(text);
}
