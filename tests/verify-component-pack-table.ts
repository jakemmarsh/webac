/**
 * ACCWeenieObject::IsComponentPack @ 00588400 reads DBObj::GetByEnum(5,
 * 0x10000001, 0x28): master DidMapper 0x25000000 [0x10000001] → the
 * Materials/Gems/…/ComponentPacks DidMapper, [5] → DualDidMapper 0x27000003.
 * The client reads that table by COMPONENT_PACKS_DID_MAPPER_ID; this pins
 * the id against the DAT chain and the wcids it yields (the five foci).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { readDidMapper } from '../packages/dat-parser/src/file-types/DidMapper.js';
import { readDualDidMapper } from '../packages/dat-parser/src/file-types/DualDidMapper.js';
import { COMPONENT_PACKS_DID_MAPPER_ID, isComponentPack } from '../packages/renderer/src/input/UseObject.js';

describe.skipIf(!existsSync(DAT_PATHS.portal))('ComponentPacks table (IsComponentPack)', () => {
  let packs: Set<number>;
  let resolvedId = 0;
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    const master = readDidMapper(portal.getReader(portal.masterMapId));
    const kind = readDidMapper(portal.getReader(master.client.enumToId.get(0x10000001)!));
    resolvedId = kind.client.enumToId.get(5)!;
    expect(kind.client.enumToName.get(5)).toBe('ComponentPacks');
    packs = new Set(readDualDidMapper(portal.getReader(COMPONENT_PACKS_DID_MAPPER_ID)).client.enumToId.values());
  });

  it('GetByEnum(5, 0x10000001) resolves to the table the client reads', () => {
    expect(resolvedId).toBe(COMPONENT_PACKS_DID_MAPPER_ID);
  });
  it('the table holds the five foci wcids', () => {
    expect([...packs].filter((w) => w !== 0).sort((a, b) => a - b)).toEqual([15268, 15269, 15270, 15271, 43173]);
    expect(isComponentPack(15271, packs)).toBe(true);
    expect(isComponentPack(0x2d /* not a pack */, packs)).toBe(false);
  });
});
