/**
 * Character creation against the 1999 world (era `ac1999-retail`) under the
 * end-of-retail chargen pages — an interim surface until the 1999 interface
 * (docs/ac1999-support-scope.md Phases 5 and 8).
 *
 * The world portal's CharGen is the 1999 one translated to the end-of-retail
 * format (dat-parser era1999/Tables1999.ts): 3 heritages, 8 templates each
 * (template 0 "Adventurer" is the custom one) and 18 named start areas of 2
 * positions. Its description strings have no slot in that format, so this
 * reads their ids from the untranslated file (readCharGen1999Text) and the
 * texts from the world portal's own 0x31 Strings — the 1999 text in place of
 * end-of-retail strings that describe content the 1999 world doesn't have.
 *
 * Only a pre-ToD world portal yields one; every other era gets null and
 * keeps its pages exactly as before.
 */
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { LanguageString } from '@ac/dat-parser/file-types/LanguageString.js';
import { readCharGen1999Text, type CharGen1999Text } from '@ac/dat-parser/era1999/Tables1999.js';
import { AC1999_OVERLAY_KIND } from '@ac/dat-parser/era1999/Ac1999Overlay.js';

const CHARGEN_ID = 0x0e000002;

export interface Chargen1999 {
  /** The heritage's description (the Heritage page's lore panel), or null. */
  heritageText(heritage: number): string | null;
  /** The template's description (the Profession page's text box), or null. */
  templateText(heritage: number, templateIndex: number): string | null;
  /** The sex's description (the heritage's naming conventions), or null. */
  sexText(heritage: number, gender: number): string | null;
  /**
   * A 1999 page's help text (Chargen1999Page), or null: the CharGen's eight
   * page help ids, which each CG_n_UI ctor hands its CGHelp box
   * (@ 0x0056c5e0 on CharGen +0x28 + 4 x page).
   */
  pageHelp(page: Chargen1999Page): string | null;
}

/**
 * The 1999 CharGen's page help ids by the page that shows them: the CG_n_UI
 * ctors read CharGen +0x28 (CG_2_UI, Sex) … +0x44 (CG_10_UI, Name and
 * Summary) in file order. On the retail CD: 0x3100001f, 0x31000013–0x31000019.
 */
export enum Chargen1999Page {
  Sex = 0,
  Appearance = 1,
  Clothing = 2,
  Heraldry = 3,
  Attributes = 4,
  Skills = 5,
  Spells = 6,
  NameAndSummary = 7,
}

/** A 1999 String (0x31, served as an EoL LanguageString by the overlay), or null. */
function worldString(db: DatDatabase, id: number | undefined): string | null {
  if (!id || (id >>> 24) !== 0x31) return null;
  try {
    const data = db.getFileData(id);
    if (!data) return null;
    const text = LanguageString.read(new DatReader(data)).charBuffer;
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * The chargen text of a 1999 world portal (the pre-ToD file, or a streamed
 * 1999 world set wearing the 1999 overlay), or null for every other era (or
 * when unreadable).
 */
export function loadChargen1999(worldPortal: DatDatabase | null): Chargen1999 | null {
  if (!worldPortal || (worldPortal.container !== 'pre-tod' && worldPortal.overlayKind !== AC1999_OVERLAY_KIND)) return null;
  let ids: CharGen1999Text;
  try {
    const raw = worldPortal.getUntranslatedFileData(CHARGEN_ID);
    if (!raw) return null;
    ids = readCharGen1999Text(raw);
  } catch {
    return null;
  }
  const cache = new Map<number, string | null>();
  const str = (id: number | undefined): string | null => {
    if (id === undefined) return null;
    if (cache.has(id)) return cache.get(id) ?? null;
    // A streamed string not resident yet is read again on the next render (chargen repaints on arrival).
    const epoch = datMissEpoch();
    const text = worldString(worldPortal, id);
    if (noDatMissSince(epoch)) cache.set(id, text);
    return text;
  };
  return {
    heritageText: (h) => str(ids.heritages.get(h)?.description),
    templateText: (h, t) => str(ids.heritages.get(h)?.templates[t]),
    sexText: (h, g) => str(ids.heritages.get(h)?.sexes.get(g)),
    pageHelp: (page) => str(ids.pages[page]),
  };
}

/**
 * The 1999 client has no Town page (VISUAL.ac1999-chargen-town-page). Its
 * ten chargen pages are CG_1_UI … CG_10_UI (Heritage Group, Sex, Appearance,
 * Clothing, Heraldry Symbol, Profession, Attributes, Skills, Spells, Name and
 * Summary), and the start area is a menu on the last one: CG_10_UI ctor
 * @ 0x005660e0 builds the "Starting Town" label (0x268,0xa2) 150x18 beside
 * "Character Name" (0x181,0xa2), and under it the menu 0x005d1ef0
 * (0x268,0xb6) 117x25 — the class CG_4_UI uses for its clothing colour
 * menus. No map, no picture, no description: the 1999 CharGen's start-area
 * records are a name and positions only (Tables1999 transcodeCharGen1999),
 * and none of the world portal's 27 0x31 Strings mentions a town.
 */
export const STARTING_TOWN_LABEL_1999 = 'Starting Town';

/**
 * The order of the 1999 "Starting Town" menu (CG_10_UI_Update @ 0x00568370,
 * run when the heritage or sex changes). The menu is cleared, then the
 * heritage's primary start areas are added in a random order, then its
 * secondary ones in a random order: @ 0x004afe90 counts the
 * unused slots, draws rand() within that count (0x004afe40) and takes that
 * unused slot, each pass sized by its own list (`mov ecx,[eax+0x18]` /
 * `[eax+0x20]` before each call). Each name goes in through 0x00569dc0
 * @ 0x00569dc0: the rows whose first word (up to a space) matches the new
 * name's form a group, the new name goes before the first row of that group
 * it sorts below (strcmp), else right after the group, and a name whose first
 * word is new goes last. So the towns come in a random order, each town's
 * areas together and alphabetical ("Holtburg South", "Holtburg West").
 * `randInt(n)` is rand() within [0, n).
 */
export function startingTownMenuOrder1999(
  heritage: { primaryStartAreas: readonly number[]; secondaryStartAreas: readonly number[] } | undefined,
  nameOf: (area: number) => string,
  starterAreaCount: number,
  randInt: (n: number) => number,
): number[] {
  const lists = heritage ? [heritage.primaryStartAreas, heritage.secondaryStartAreas] : [];
  const menu: number[] = [];
  const firstWordMatches = (a: string, b: string): boolean => {
    for (let i = 0; ; i++) {
      const ca = a[i] ?? '', cb = b[i] ?? '';
      if (ca === ' ' || ca === '' || cb === ' ' || cb === '') return true;
      if (ca !== cb) return false;
    }
  };
  const insert = (area: number): void => {
    const name = nameOf(area);
    let inGroup = false;
    for (let i = 0; i < menu.length; i++) {
      const row = nameOf(menu[i]);
      const same = firstWordMatches(name, row);
      if (same) inGroup = true;
      if (inGroup && !same) { menu.splice(i, 0, area); return; }
      if (same && name < row) { menu.splice(i, 0, area); return; }
    }
    menu.push(area);
  };
  for (const all of lists) {
    // An index past the CharGen's start areas would read past them in 1999; drop it.
    const list = all.filter((a) => a >= 0 && a < starterAreaCount);
    const used = list.map(() => false);
    for (let k = 0; k < list.length; k++) {
      const pick = randInt(used.filter((u) => !u).length);
      let seen = 0;
      for (let j = 0; j < list.length; j++) {
        if (used[j]) continue;
        if (seen++ === pick) { used[j] = true; insert(list[j]); break; }
      }
    }
  }
  const out = menu.filter((a, i) => menu.indexOf(a) === i);
  return out.length || lists.some((l) => l.length) ? out : Array.from({ length: starterAreaCount }, (_, i) => i);
}

/**
 * The start areas the town list offers for `heritage`: its primary then
 * secondary start-area lists (CharGen; on the retail CD they cover all 18,
 * the heritage's own six towns first), without repeats and within the
 * CharGen's start areas. A heritage with no lists offers every area.
 */
export function startAreasFor1999(
  heritage: { primaryStartAreas: readonly number[]; secondaryStartAreas: readonly number[] } | undefined,
  starterAreaCount: number,
): number[] {
  const listed = heritage ? [...heritage.primaryStartAreas, ...heritage.secondaryStartAreas] : [];
  const out: number[] = [];
  for (const a of listed) if (a >= 0 && a < starterAreaCount && !out.includes(a)) out.push(a);
  return out.length ? out : Array.from({ length: starterAreaCount }, (_, i) => i);
}
