/**
 * BUG.cell-static-lit-darker — checked, retail (no code change).
 *
 * The Dark Majesty Holtburg portal bunker's stair-foot ramp, GfxObj
 * 0x010011C4 in EnvCell 0xA9B40185, draws much darker than the room walls
 * around it. It is not a lighting-path bug: the ramp is drawn exactly like the
 * pillars beside it (the `cellobject` set, PView::DrawCells @ 005a4840 →
 * DrawObjCell → Render::minimize_object_lighting @ 0054d480), and the walls by
 * the same hardware light equation (`envcell`; RenderMeshSubset @ 0059ca10
 * sets a burned-in cell's D3D material Ambient = Diffuse = diffuseVal, which
 * acclient.exe .data @ 0x820e28 holds as 1.0f, the same as an object's white
 * vertex colour). The difference is the DAT's vertex normals: the ramp's are
 * the corner averages of its three faces, so on the slope (the face toward the
 * room) they agree with the face normal by only 0.14–0.33, and the viewer
 * light barely reaches it. Retail lights with those same normals:
 * D3DPolyRender::ConstructMesh @ 0059dfa0 → copyVert @ 0059c080 copies the
 * CSWVertex normal (sign ±1) into the D3D vertex, and nothing in the client
 * recomputes normals. Over half the GfxObjs placed in env cells (classic
 * 1197 / 2182, end of retail 1962 / 3298) have a face like that.
 *
 * Pinned here so nobody "fixes" it by swapping in face normals: the shipped
 * mesh keeps the DAT normals, and the ramp and the pillars take the same light
 * set.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { openDat } from './_harness/dat.js';

const CLASSIC = {
  portal: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_portal.dat'),
  cell: resolve(__dirname, '..', 'dat/sets/classic-dereth/client_cell_1.dat'),
};
const haveDat = existsSync(CLASSIC.portal) && existsSync(CLASSIC.cell);
const ROOM = 0xa9b40185;
const RAMP = 0x010011c4;
const PILLAR_PART = 0x01000f68;

describe.skipIf(!haveDat)('BUG.cell-static-lit-darker — the bunker ramp keeps its DAT vertex normals (classic DATs)', () => {
  /** Per mesh in the room's group: [name, lighting kind]. */
  const kinds: Array<[string, string | undefined]> = [];
  let rampNormals: Float32Array;
  let datNormals: number[];
  /** Per ramp face: the mean agreement of its DAT vertex normals with the face normal. */
  let slopeAgreement = 1;
  /** The viewer light on the slope's vertices, with the DAT normals and with the face normal. */
  let slopeLitDat = 0;
  let slopeLitFace = 0;

  beforeAll(async () => {
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { SceneryInstancer } = await import('../packages/renderer/src/terrain/SceneryInstancer.js');
    const { retailLightingKindOf, retailHardwarePointLight } = await import('../packages/renderer/src/models/RetailLighting.js');
    const { VIEWER_LIGHT_INTENSITY, VIEWER_LIGHT_FALLOFF } = await import('../packages/renderer/src/effects/ViewerLight.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { GfxObj } = await import('../packages/dat-parser/src/file-types/GfxObj.js');

    const portalDb = openDat(CLASSIC.portal);
    const cellDb = openDat(CLASSIC.cell);
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    const ecr = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    ecr.setInstancer(new SceneryInstancer(mr, sr));
    const room = ecr.createCellMesh(ROOM)!;
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      kinds.push([m.userData.cellGeometry ? 'cell' : o.name, retailLightingKindOf(mat)]);
    });

    const ramp = mr.createMesh(RAMP)!;
    rampNormals = ((ramp.children[0] as THREE.Mesh).geometry.getAttribute('normal').array as Float32Array);

    const g = new GfxObj(new DatReader(portalDb.getFileData(RAMP)!));
    const V = g.vertexArray!.vertices;
    datNormals = [];
    for (const key of [...V.keys()].sort((a, b) => a - b)) {
      const v = V.get(key)!;
      for (let i = 0; i < Math.max(1, v.uvs.length); i++) datNormals.push(v.normal.x, v.normal.z, v.normal.y);
    }

    // The slope: the face pointing up. The stab is turned 180° about z (AC), the
    // player stands in the room 4 m off it, the viewer light 2 m over his origin.
    const turn = (v: { x: number; y: number; z: number }): [number, number, number] => [-v.x, -v.y, v.z];
    const origin = [108.1, 78.185, 73.6475];
    const light: [number, number, number] = [108, 74, 75.7];
    for (const poly of g.polygons) {
      const P = poly.vertexIndices.map(i => V.get(i)!);
      const a = P[0].origin, b = P[1].origin, c = P[2].origin;
      const u = [b.x - a.x, b.y - a.y, b.z - a.z], w = [c.x - a.x, c.y - a.y, c.z - a.z];
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(n[0], n[1], n[2]);
      const fn = { x: n[0] / len, y: n[1] / len, z: n[2] / len };
      if (fn.z < 0.5) continue;
      slopeAgreement = P.reduce((s, v) => s + v.normal.x * fn.x + v.normal.y * fn.y + v.normal.z * fn.z, 0) / P.length;
      for (const v of P) {
        const o = turn(v.origin);
        const at: [number, number, number] = [origin[0] + o[0], origin[1] + o[1], origin[2] + o[2]];
        slopeLitDat += retailHardwarePointLight(at, turn(v.normal), light, [1, 1, 1], VIEWER_LIGHT_INTENSITY, VIEWER_LIGHT_FALLOFF)[0] / P.length;
        slopeLitFace += retailHardwarePointLight(at, turn(fn), light, [1, 1, 1], VIEWER_LIGHT_INTENSITY, VIEWER_LIGHT_FALLOFF)[0] / P.length;
      }
    }
  }, 120_000);

  it('the ramp, the pillars and the room take the cell light sets (no sun; the pool lights)', () => {
    const ramp = kinds.filter(([n]) => n.includes('010011c4'));
    const pillars = kinds.filter(([n]) => n.includes(PILLAR_PART.toString(16).padStart(8, '0')));
    const cell = kinds.filter(([n]) => n === 'cell');
    expect(ramp.length).toBeGreaterThan(0);
    expect(pillars.length).toBeGreaterThan(0);
    expect(cell.length).toBeGreaterThan(0);
    for (const [, k] of [...ramp, ...pillars]) expect(k).toBe('cellobject');
    for (const [, k] of cell) expect(k).toBe('envcell');
  });

  it('the shipped mesh carries the DAT vertex normals (copyVert), not face normals', () => {
    expect(rampNormals.length).toBe(datNormals.length);
    for (let i = 0; i < datNormals.length; i++) expect(rampNormals[i]).toBeCloseTo(datNormals[i], 5);
  });

  it('those normals are why the slope is dark: they barely agree with the face, so the viewer light barely reaches it', () => {
    expect(slopeAgreement).toBeLessThan(0.3);
    expect(slopeLitFace).toBeGreaterThan(0.3);
    expect(slopeLitDat).toBeLessThan(slopeLitFace / 4);
  });
});
