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
  };
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
