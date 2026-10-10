/**
 * The DAT lookups the examine pages name things through
 * (ItemAppraisalText / CreatureAppraisalText take them injected):
 *  - EnumMappers in portal.dat: 0x2200000A gender, 0x2200000B heritage,
 *    0x2200000E creature type (enum ids 0x10000001/2/5), 0x22000041
 *    character-title tokens → StringTable 0x2300000E entry
 *    acStringHash(token) (CharacterTitleTable::GetCharacterTitleFromID);
 *  - SkillTable 0x0E000004 names; SpellTable 0x0E00000E name + description;
 *  - MaterialTypeEnumMapper — @ac/shared getMaterialName.
 * Mappers load lazily, once.
 */
import { DatReader, getStringFromTable, acStringHash, type DatDatabase } from '@ac/dat-parser';
import { readEnumMapper } from '@ac/dat-parser/file-types/EnumMapper.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';
import { getMaterialName } from '@ac/shared';
import type { ItemAppraisalResolvers } from './ItemAppraisalText.js';
import type { CreatureExamineContext } from './CreatureAppraisalText.js';

export const EXAMINE_ENUM_MAPPERS = { gender: 0x2200000a, heritage: 0x2200000b, creatureType: 0x2200000e, characterTitle: 0x22000041 } as const;
export const CHARACTER_TITLE_STRING_TABLE = 0x2300000e;

export interface ExamineResolverSources {
  portalDb: Pick<DatDatabase, 'getFileData'>;
  spell: (id: number) => { name: string; desc?: string; description?: string } | null | undefined;
  skillName: (id: number) => string | null | undefined;
}

export function createExamineResolvers(src: ExamineResolverSources): {
  item: ItemAppraisalResolvers;
  creature: Pick<CreatureExamineContext, 'genderEnumName' | 'heritageEnumName' | 'creatureTypeEnumName' | 'characterTitle'>;
} {
  const maps = new Map<number, Map<number, string> | null>();
  const mapper = (id: number): Map<number, string> | null => {
    if (!maps.has(id)) {
      let m: Map<number, string> | null = null;
      const epoch = datMissEpoch();
      try {
        const d = src.portalDb.getFileData(id);
        if (d) m = readEnumMapper(new DatReader(d)).idToStringMap;
      } catch { m = null; }
      // RELEASE.streaming-regression-gate — a streamed miss is not "absent".
      if (!noDatMissSince(epoch)) return m;
      maps.set(id, m);
    }
    return maps.get(id) ?? null;
  };
  const name = (id: number) => (v: number) => mapper(id)?.get(v) ?? null;
  const characterTitle = (titleId: number): string | null => {
    const token = mapper(EXAMINE_ENUM_MAPPERS.characterTitle)?.get(titleId);
    return token ? getStringFromTable(CHARACTER_TITLE_STRING_TABLE, acStringHash(token)) : null;
  };
  return {
    item: {
      spell: (id) => { const s = src.spell(id); return s ? { name: s.name, description: s.description ?? s.desc ?? '' } : null; },
      skillName: src.skillName,
      heritageName: name(EXAMINE_ENUM_MAPPERS.heritage),
      creatureTypeName: name(EXAMINE_ENUM_MAPPERS.creatureType),
      materialName: (m) => getMaterialName(m),
    },
    creature: {
      genderEnumName: name(EXAMINE_ENUM_MAPPERS.gender),
      heritageEnumName: name(EXAMINE_ENUM_MAPPERS.heritage),
      creatureTypeEnumName: name(EXAMINE_ENUM_MAPPERS.creatureType),
      characterTitle,
    },
  };
}
