/**
 * DECOMP.interior-objects-culled — an object in an env cell is drawn exactly
 * when its cell is (retail `PView::DrawCells` @ 005a4840 draws each reached
 * cell's objects with it via `DrawObjCell` @ 005a1a40). There is no
 * per-object "player outdoors → hide every interior object" gate: the
 * UI.32 rule it replaces hid every Holtburg shopkeeper, door, chest and the
 * Meeting Hall portal (live-confirmed 2026-09-30).
 *
 * Drives the real ServerObjectManager.updateInteriorVisibility with the real
 * cell rules (applySurfaceCellVisibility / surfaceCellDrawn /
 * objectCellDrawn / DungeonRenderer.isCellDrawn).
 */
import { describe, it, expect } from 'vitest';
import { PhysicsState } from '@ac/shared';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import {
  applySurfaceCellVisibility, surfaceCellDrawn, objectCellDrawn, type SurfaceCellBlock,
} from '../packages/renderer/src/world/buildingCells.js';
import { DungeonRenderer } from '../packages/renderer/src/world/DungeonRenderer.js';

function makeSOM(): ServerObjectManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
}

function obj(guid: number, objCellId: number, physicsState = 0): ServerObject {
  return {
    guid, name: '', weenieClassId: 0, setupId: 0, iconId: 0, itemType: 0,
    physicsState, position: null, worldX: 0, worldY: 0, worldZ: 0,
    radarColor: 0, radarBehavior: 0, usable: 0, targetType: 0, useRadius: 0.6, stackSize: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mesh: { visible: true, userData: {} } as any, basePalette: 0,
    subPalettes: [], textureChanges: [], animPartChanges: [], motionTableId: 0,
    soundTableId: 0, objectDescFlags: 0, wielderId: 0, wieldedLocation: 0,
    parentLocation: 0,
    collisionRadius: 0, blockRadius: 0, collisionHeight: 0,
    cellId: objCellId & 0xffff, objCellId, healthCurrent: 0, healthMax: 0, staminaCurrent: 0,
    staminaMax: 0, manaCurrent: 0, manaMax: 0, lastStateSequence: -1, lastVisualDescSeq: -1,
  };
}

// Holtburg-like block 0xA9B4: a shop whose doorway cell 0x0100 is a building
// portal stab cell; 0x0101 is a back room only reachable from inside.
const BLOCK = 0xA9B4;
function holtburgRegistry() {
  const block: SurfaceCellBlock = {
    meshes: new Map([[0x0100, { visible: false }], [0x0101, { visible: false }]]),
    stabSet: new Set([0x0100]),
  };
  return new Map([[BLOCK, block]]);
}
const cellOf = (idx: number) => ((BLOCK << 16) | idx) >>> 0;

describe('DECOMP.interior-objects-culled — objects draw with their cell', () => {
  it('only env-cell indices (0x0100–0xFFFD) are culled with their cell; land cells and the block ids never are', () => {
    const som = makeSOM();
    const cases: Array<[number, boolean]> = [[0x0001, false], [0x0040, false], [0xfffe, false], [0xffff, false], [0x0100, true], [0xfffd, true]];
    cases.forEach(([idx], i) => som.getAllObjects().set(100 + i, obj(100 + i, cellOf(idx))));
    som.updateInteriorVisibility(() => false); // no cell is drawn
    cases.forEach(([idx, culled], i) => {
      expect(som.getObject(100 + i)!._culledByCell, `cell index 0x${idx.toString(16)}`).toBe(culled);
    });
  });

  it('a shopkeeper in the doorway cell is visible from the street (player outdoors)', () => {
    const registry = holtburgRegistry();
    applySurfaceCellVisibility(registry, -1, new Set()); // player outdoors
    const som = makeSOM();
    const renald = obj(1, cellOf(0x0100));
    som.getAllObjects().set(1, renald);
    som.updateInteriorVisibility((c) => objectCellDrawn(c, null, registry));
    expect(renald.mesh!.visible).toBe(true);
    expect(renald._culledByCell).toBe(false);
  });

  it('an object in a room no portal view reaches is not drawn; walking in draws it', () => {
    const registry = holtburgRegistry();
    const som = makeSOM();
    const chest = obj(2, cellOf(0x0101));
    som.getAllObjects().set(2, chest);

    applySurfaceCellVisibility(registry, -1, new Set());
    som.updateInteriorVisibility((c) => objectCellDrawn(c, null, registry));
    expect(chest.mesh!.visible).toBe(false);

    // Player inside the doorway cell, whose PVS includes the back room.
    applySurfaceCellVisibility(registry, BLOCK, new Set([0x0100, 0x0101]));
    som.updateInteriorVisibility((c) => objectCellDrawn(c, null, registry));
    expect(chest.mesh!.visible).toBe(true);
  });

  it('land-cell objects are never cell-culled', () => {
    const som = makeSOM();
    const drudge = obj(3, 0xA9B4001F);
    som.getAllObjects().set(3, drudge);
    som.updateInteriorVisibility(() => false);
    expect(drudge.mesh!.visible).toBe(true);
  });

  it('an env-cell object whose cell no renderer holds stays drawn (nothing to cull by)', () => {
    const som = makeSOM();
    const npc = obj(4, 0x12340105);
    som.getAllObjects().set(4, npc);
    som.updateInteriorVisibility((c) => objectCellDrawn(c, null, new Map()));
    expect(npc.mesh!.visible).toBe(true);
  });

  it('Hidden / NoDraw still hide an object in a drawn cell', () => {
    const som = makeSOM();
    const a = obj(5, cellOf(0x0100), PhysicsState.Hidden);
    const b = obj(6, cellOf(0x0100), PhysicsState.NoDraw);
    som.getAllObjects().set(5, a);
    som.getAllObjects().set(6, b);
    som.updateInteriorVisibility(() => true);
    expect(a.mesh!.visible).toBe(false);
    expect(b.mesh!.visible).toBe(false);
  });
});

describe('cell-drawn queries', () => {
  it('surfaceCellDrawn: mesh visibility; unbuilt cell of a registered block = not drawn; unknown block = undefined', () => {
    const registry = holtburgRegistry();
    applySurfaceCellVisibility(registry, -1, new Set());
    expect(surfaceCellDrawn(registry, cellOf(0x0100))).toBe(true);
    expect(surfaceCellDrawn(registry, cellOf(0x0101))).toBe(false);
    expect(surfaceCellDrawn(registry, cellOf(0x0150))).toBe(false);
    expect(surfaceCellDrawn(registry, 0x01020100)).toBeUndefined();
  });

  it('DungeonRenderer.isCellDrawn reads the streamed cell mesh; objectCellDrawn ORs the renderers', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dr = new DungeonRenderer({} as any, {} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meshes = (dr as any).loadedCellMeshes as Map<number, { visible: boolean }>;
    meshes.set(0x01030100, { visible: true });
    meshes.set(0x01030101, { visible: false });
    expect(dr.isCellDrawn(0x01030100)).toBe(true);
    expect(dr.isCellDrawn(0x01030101)).toBe(false);
    expect(dr.isCellDrawn(0x01030102)).toBeUndefined();

    const dungeon = (c: number) => dr.isCellDrawn(c);
    expect(objectCellDrawn(0x01030100, dungeon, new Map())).toBe(true);
    expect(objectCellDrawn(0x01030101, dungeon, new Map())).toBe(false);
    expect(objectCellDrawn(0x01030102, dungeon, new Map())).toBeUndefined();
    // The surface rule draws a cell the dungeon stream hides → drawn.
    const registry = holtburgRegistry();
    applySurfaceCellVisibility(registry, -1, new Set());
    expect(objectCellDrawn(cellOf(0x0100), () => false, registry)).toBe(true);
  });
});
