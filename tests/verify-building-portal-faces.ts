/**
 * BLDG.portal-face-drawn-over-interior → RENDER.untextured-skipped-in-buildings-and-cells.
 *
 * The Training Academy pyramid at Holtburg West Outpost (building
 * 0x010014C3) showed a bright blue slab in its doorway: polygon 1, surface
 * 0x080006FD (solid 0xFF0000FF). Retail never draws it, and not because it
 * is a portal: D3DPolyRender::DrawMesh @ 0059d4a0 skips every mesh subset
 * whose surface is untextured (`(type & 6) == 0`) while
 * RenderDeviceD3D::ObjBuildingOrBuildingPart is set (DrawBuilding @ 0059f2a0,
 * around the building's part draw) or its bool is set (DrawEnvCell @
 * 0059f170) — skipNoTexture is 1 in acclient.exe's .data. Every drawing-BSP
 * portal face of the EoL buildings is untextured, so the building pass
 * (ModelRenderer.createMesh `buildingPass`) covers them and also the seam
 * faces (0x01002286's black 0x080000DF). Ordinary objects keep their
 * untextured surfaces; env cells skip them (the pink 0x08000B79 slabs of the
 * 0xB2AA cells).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ModelRenderer, surfaceIsTextured } from '../packages/renderer/src/models/ModelRenderer.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { EnvCellRenderer } from '../packages/renderer/src/world/EnvCellRenderer.js';
import { Surface } from '../packages/dat-parser/src/file-types/Surface.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/** Two quads: polygon 0 on a textured surface, polygon 1 on a solid-colour one. */
function stubRenderer(): ModelRenderer {
  const types = new Map<number, number>([[0x08000001, 0x2], [0x080006fd, 0x1]]);
  const factory = {
    getSurface: (id: number) => { const s = new Surface(); s.type = types.get(id) ?? 0x2; return s; },
    getMaterial: () => new THREE.MeshBasicMaterial(),
  } as unknown as MaterialFactory;
  const r = new ModelRenderer({ getFileData: () => null } as unknown as DatDatabase, factory);
  const vertices = new Map<number, unknown>();
  [[0, 0], [1, 0], [1, 1], [0, 1], [2, 0], [3, 0], [3, 1], [2, 1]].forEach(([x, y], i) =>
    vertices.set(i, { origin: { x, y, z: 0 }, normal: { x: 0, y: 0, z: 1 }, uvs: [{ u: 0, v: 0 }] }));
  const wall = { vertexIndices: [0, 1, 2, 3], posUVIndices: [0, 0, 0, 0], negUVIndices: [], posSurface: 0, negSurface: -1, sidesType: 0, stippling: 0 };
  const door = { vertexIndices: [4, 5, 6, 7], posUVIndices: [], negUVIndices: [], posSurface: 1, negSurface: -1, sidesType: 0, stippling: 4 };
  const gfxObj = { surfaces: [0x08000001, 0x080006fd], vertexArray: { vertices }, polygons: [wall, door], polygonMap: new Map(), physicsPolygons: new Map(), drawingBSP: null };
  r.loadGfxObj = () => gfxObj as never;
  return r;
}

const surfacesOf = (g: THREE.Group | null): number[] => (g?.children ?? []).map(c => c.userData.surfaceId as number).sort();

describe('the building pass skips untextured surfaces; ordinary objects keep them', () => {
  it('buildingPass drops the solid-colour subset', () => {
    expect(surfacesOf(stubRenderer().createMesh(0x01000001, undefined, undefined, true))).toEqual([0x08000001]);
  });
  it('an ordinary object draws both', () => {
    expect(surfacesOf(stubRenderer().createMesh(0x01000001))).toEqual([0x08000001, 0x080006fd]);
  });
  it('the textured test is DrawMesh\'s (type & 6)', () => {
    const s = new Surface();
    for (const [type, textured] of [[0x1, false], [0x11, false], [0x2, true], [0x4, true], [0x10114, true]] as const) {
      s.type = type;
      expect(surfaceIsTextured(s)).toBe(textured);
    }
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('EoL buildings, objects and cells (DAT)', () => {
  let portal: DatDatabase;
  let models: ModelRenderer;
  let cells: EnvCellRenderer;
  beforeAll(() => {
    portal = openDat(DAT_PATHS.portal);
    const factory = new MaterialFactory(portal, new TextureManager(portal));
    models = new ModelRenderer(portal, factory);
    cells = new EnvCellRenderer(portal, openDat(DAT_PATHS.cell), factory);
  });

  it('the pyramid 0x010014C3 draws no blue doorway (or other untextured face) as a building; its walls still draw', () => {
    const g = models.createMesh(0x010014c3, undefined, undefined, true);
    const ids = surfacesOf(g);
    expect(ids).not.toContain(0x080006fd); // portal 1 — solid 0xFF0000FF
    expect(ids).not.toContain(0x080006b0); // portal 0 — the translucent roof opening
    expect(ids).toContain(0x08000233); // the 64 stone-wall polygons
  });

  it('building 0x01002286 draws none of its black 0x080000DF seam faces', () => {
    expect(surfacesOf(models.createMesh(0x01002286, undefined, undefined, true))).not.toContain(0x080000df);
    expect(surfacesOf(models.createMesh(0x01002286))).toContain(0x080000df);
  });

  it('an ordinary object keeps an untextured surface (0x01000EE1\'s red eye triangles)', () => {
    expect(surfacesOf(models.createMesh(0x01000ee1))).toEqual([0x080006f9]);
  });

  it('the 0xB2AA cells (only untextured pink 0x08000B79 / 0x08000B7A faces) draw no structure; a dungeon cell still does', () => {
    const structural = (cellId: number): number => {
      let n = 0;
      cells.createCellMesh(cellId)?.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.userData.cellGeometry) n++; });
      return n;
    };
    expect(cells.loadEnvCell(0xb2aa0100)!.surfaces).toEqual([0x08000b79, 0x08000b7a]);
    expect(structural(0xb2aa0100)).toBe(0);
    expect(structural(0x01030100)).toBeGreaterThan(0);
  });
});
