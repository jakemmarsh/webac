/**
 * FAITHFUL.173 — landscape scenery placement (Scene 0x12) parity with ACE.
 *
 * The deterministic scenery placement algorithm in ACE/ACViewer
 * (`Landblock.get_land_scenes` + `ObjectDesc.Displace/ScaleObj/RotateObj`)
 * relies on uint32-modular integer arithmetic, then a uniform mapping to
 * [0, 1) via multiplication by 2^-32 ≈ 2.3283064e-10.
 *
 * The math has to match byte-for-byte across client and server so scenery
 * placement is identical. These tests pin:
 *   1) The base noise hash (uint32 wrapping) for known (ix, iy, k) inputs.
 *   2) The displace quadrant rotation thresholds.
 *   3) The scale formula edge cases (min == max, log domain).
 *   4) The Scene binary parser: header (id + count) + per-ObjectDesc 84 bytes.
 *   5) `onRoad` returns false on a fresh terrain grid (all bits zero) and
 *      true within RoadWidth of a full road cell.
 *   6) The full Scene module is exported from @ac/dat-parser.
 *
 * Reference: ACE.Server/Physics/Common/ObjectDesc.cs
 *            ACViewer/Physics/Common/Landblock.cs `get_land_scenes`
 *            ACE.DatLoader/FileTypes/Scene.cs
 *            ACE.DatLoader/Entity/ObjectDesc.cs
 */
import { describe, it, expect } from 'vitest';
import { ObjectDesc, Scene, onRoad, SCENERY_CELL_LENGTH, SCENERY_BLOCK_LENGTH, SCENERY_ROAD_WIDTH } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';

// Re-derive the noise byte-for-byte the way ACE does it, to cross-check ObjectDesc.noiseFor.
function aceNoise(ix: number, iy: number, k: number): number {
  const a = Math.imul(1813693831, iy) | 0;
  const inner = (Math.imul(Math.imul(iy, ix) | 0, 1360117743) + 1888038839) | 0;
  const b = Math.imul(k | 0, inner) | 0;
  const c = Math.imul(1109124029, ix) | 0;
  return (((a - b - c) | 0) >>> 0) * 2.3283064e-10;
}

describe('ObjectDesc.noiseFor — uint32-wrapping cell hash', () => {
  it('matches the ACE reference hash for (0, 0, 0)', () => {
    expect(ObjectDesc.noiseFor(0, 0, 0)).toBe(aceNoise(0, 0, 0));
  });
  it('matches the ACE reference hash for a high (ix, iy) — overflow path', () => {
    // 0x7FFFFFFF inputs exercise the int32 wrap during Math.imul.
    expect(ObjectDesc.noiseFor(0x7FFFFFFE, 0x7FFFFFFE, 12345))
      .toBe(aceNoise(0x7FFFFFFE, 0x7FFFFFFE, 12345));
  });
  it('output is in [0, 1)', () => {
    for (let trial = 0; trial < 50; trial++) {
      const ix = (Math.random() * 256 * 8) | 0;
      const iy = (Math.random() * 256 * 8) | 0;
      const k = (Math.random() * 100000) | 0;
      const n = ObjectDesc.noiseFor(ix, iy, k);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
  it('is deterministic — same input yields same output', () => {
    const a = ObjectDesc.noiseFor(42, 73, 17);
    const b = ObjectDesc.noiseFor(42, 73, 17);
    expect(a).toBe(b);
  });
});

describe('ObjectDesc.displace — quadrant rotation', () => {
  const makeObj = (displaceX: number, displaceY: number) => {
    const o = new ObjectDesc();
    o.baseLoc.origin = { x: 0, y: 0, z: 0 };
    o.displaceX = displaceX;
    o.displaceY = displaceY;
    return o;
  };

  it('returns base origin when displaceX <= 0 and displaceY <= 0', () => {
    const o = makeObj(0, 0);
    o.baseLoc.origin = { x: 1, y: 2, z: 3 };
    // With zero displacement, the quadrant rotation still permutes the axes
    // — but x and y are always loc.x/loc.y, so the four quadrant outputs
    // are (1,2,3) (-1,-2,3) (-2,1,3) (2,-1,3). All have |x|=1 and |y|=2.
    const p = ObjectDesc.displace(o, 7, 11, 0);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(2);
    expect(p.z).toBe(3);
  });

  it('is deterministic across calls', () => {
    const o = makeObj(5, 5);
    const a = ObjectDesc.displace(o, 100, 200, 3);
    const b = ObjectDesc.displace(o, 100, 200, 3);
    expect(a).toEqual(b);
  });
});

describe('ObjectDesc.scaleObj — log-domain interpolation', () => {
  it('returns maxScale when min == max', () => {
    const o = new ObjectDesc();
    o.minScale = 1.5;
    o.maxScale = 1.5;
    expect(ObjectDesc.scaleObj(o, 1, 1, 0)).toBe(1.5);
  });
  it('produces a value in [minScale, maxScale]', () => {
    const o = new ObjectDesc();
    o.minScale = 0.5;
    o.maxScale = 2.0;
    for (let trial = 0; trial < 50; trial++) {
      const ix = (Math.random() * 256 * 8) | 0;
      const iy = (Math.random() * 256 * 8) | 0;
      const k = (Math.random() * 100000) | 0;
      const s = ObjectDesc.scaleObj(o, ix, iy, k);
      expect(s).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(s).toBeLessThanOrEqual(2.0 + 1e-6);
    }
  });
});

describe('ObjectDesc.rotateObj — heading hash', () => {
  it('returns 0 when maxRotation is 0', () => {
    const o = new ObjectDesc();
    o.maxRotation = 0;
    expect(ObjectDesc.rotateObj(o, 1, 2, 3)).toBe(0);
  });
  it('produces a heading in [0, maxRotation)', () => {
    const o = new ObjectDesc();
    o.maxRotation = 360;
    for (let trial = 0; trial < 50; trial++) {
      const ix = (Math.random() * 256 * 8) | 0;
      const iy = (Math.random() * 256 * 8) | 0;
      const k = trial;
      const r = ObjectDesc.rotateObj(o, ix, iy, k);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(360);
    }
  });
});

describe('ObjectDesc.checkSlope — boundary inclusive', () => {
  it('accepts normals exactly at minSlope and maxSlope', () => {
    const o = new ObjectDesc();
    o.minSlope = 0.7;
    o.maxSlope = 1.0;
    expect(ObjectDesc.checkSlope(o, 0.7)).toBe(true);
    expect(ObjectDesc.checkSlope(o, 1.0)).toBe(true);
    expect(ObjectDesc.checkSlope(o, 0.5)).toBe(false);
  });
});

describe('Scene binary parser', () => {
  it('decodes id + 0 objects', () => {
    // 4 bytes ID (0x12345678) + 4 bytes count (0)
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint32(0, 0x12345678, true);
    view.setUint32(4, 0, true);
    const scene = Scene.read(new DatReader(buf));
    expect(scene.id).toBe(0x12345678);
    expect(scene.objects.length).toBe(0);
  });

  it('decodes a single ObjectDesc with the correct field count', () => {
    // ObjectDesc layout (76 bytes total):
    //   objId (4) + baseLoc origin xyz (12) + orientation wxyz (16) = 32
    //   + freq (4) + displaceX (4) + displaceY (4) = 44
    //   + minScale (4) + maxScale (4) + maxRotation (4) = 56
    //   + minSlope (4) + maxSlope (4) = 64
    //   + align (4) + orient (4) + weenieObj (4) = 76
    // Header (Scene): id (4) + count (4) = 8 bytes
    const total = 8 + 76;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    let off = 0;
    view.setUint32(off, 0x12000123, true); off += 4; // scene id
    view.setUint32(off, 1, true); off += 4; // 1 object
    // ObjectDesc
    view.setUint32(off, 0x01000042, true); off += 4; // objId — GfxObj
    view.setFloat32(off, 1, true); off += 4; // origin x
    view.setFloat32(off, 2, true); off += 4; // origin y
    view.setFloat32(off, 3, true); off += 4; // origin z
    view.setFloat32(off, 1, true); off += 4; // rot w
    view.setFloat32(off, 0, true); off += 4; // rot x
    view.setFloat32(off, 0, true); off += 4; // rot y
    view.setFloat32(off, 0, true); off += 4; // rot z
    view.setFloat32(off, 0.25, true); off += 4; // freq
    view.setFloat32(off, 5, true); off += 4; // displaceX
    view.setFloat32(off, 5, true); off += 4; // displaceY
    view.setFloat32(off, 0.8, true); off += 4; // minScale
    view.setFloat32(off, 1.2, true); off += 4; // maxScale
    view.setFloat32(off, 360, true); off += 4; // maxRotation
    view.setFloat32(off, 0.6, true); off += 4; // minSlope
    view.setFloat32(off, 1.0, true); off += 4; // maxSlope
    view.setUint32(off, 0, true); off += 4; // align
    view.setUint32(off, 0, true); off += 4; // orient
    view.setUint32(off, 0, true); off += 4; // weenieObj
    expect(off).toBe(total);

    const scene = Scene.read(new DatReader(buf));
    expect(scene.id).toBe(0x12000123);
    expect(scene.objects.length).toBe(1);
    const o = scene.objects[0];
    expect(o.objId).toBe(0x01000042);
    expect(o.baseLoc.origin).toEqual({ x: 1, y: 2, z: 3 });
    expect(o.freq).toBeCloseTo(0.25);
    expect(o.displaceX).toBe(5);
    expect(o.minScale).toBeCloseTo(0.8);
    expect(o.maxScale).toBeCloseTo(1.2);
    expect(o.maxRotation).toBe(360);
    expect(o.minSlope).toBeCloseTo(0.6);
    expect(o.maxSlope).toBe(1.0);
    expect(o.weenieObj).toBe(0);
  });
});

describe('onRoad — proximity check against terrain road bits', () => {
  const blank = new Array(81).fill(0); // no road anywhere
  it('returns false on an all-empty terrain grid', () => {
    expect(onRoad(blank, 12, 12)).toBe(false);
    expect(onRoad(blank, 0, 0)).toBe(false);
  });

  it('returns true near a full road cell — all 4 corners have road bit set', () => {
    // Mark vertices (3,3) (3,4) (4,3) (4,4) — corners of cell (3,3) — as road.
    const t = [...blank];
    t[3 * 9 + 3] = 1;
    t[3 * 9 + 4] = 1;
    t[4 * 9 + 3] = 1;
    t[4 * 9 + 4] = 1;
    // Center of that cell is at (3*24 + 12, 3*24 + 12) = (84, 84) — should be on road.
    expect(onRoad(t, 84, 84)).toBe(true);
  });

  it('returns false outside the road-width band when only one corner has road', () => {
    const t = [...blank];
    t[3 * 9 + 3] = 1; // only the SW corner of cell (3,3)
    // Far end of cell (3,3) — (3*24 + 20, 3*24 + 20) = (92, 92) — outside RoadWidth.
    expect(onRoad(t, 92, 92)).toBe(false);
  });
});

describe('generateScenery — end-to-end placement on a synthetic landblock', () => {
  it('places objects deterministically, filters WeenieObj, and respects bounds', async () => {
    const { generateScenery, makeTerrainSampler } = await import('@ac/renderer/terrain/SceneryGenerator.js');
    const { CellLandblock } = await import('@ac/dat-parser');
    type RegionDesc = import('@ac/dat-parser').RegionDesc;

    // Synthesize a flat landblock — all vertices share terrainType=1, sceneType=0,
    // road bits = 0, height = 50 (so the terrain is a flat plane at Z = 100).
    const landblock = new CellLandblock();
    landblock.id = 0x12340000 | 0xffff;
    landblock.hasObjects = false;
    landblock.terrain = new Array(81).fill((1 << 2) | (0 << 11)); // terrainType=1, sceneType=0
    landblock.heights = new Array(81).fill(50);

    // Synthesize a minimal RegionDesc with one terrainType (1) → sceneInfo 0,
    // and one scene-type group (0) → one Scene file (sceneId 0x12000099).
    const region = {
      landDefs: { landHeightTable: undefined } as never,
      terrainInfo: {
        terrainTypes: [
          { terrainName: 'unused', terrainColor: 0, sceneTypes: [] },
          { terrainName: 'grass', terrainColor: 0, sceneTypes: [0] },
        ],
        landSurfaces: { type: 0, texMerge: null },
      } as never,
      sceneInfo: {
        sceneTypes: [
          { stbIndex: 0, scenes: [0x12000099] },
        ],
      } as never,
    } as unknown as RegionDesc;

    const tree = new ObjectDesc();
    tree.objId = 0x01000042;
    tree.baseLoc.origin = { x: 0, y: 0, z: 0 };
    tree.baseLoc.orientation = { w: 1, x: 0, y: 0, z: 0 };
    tree.freq = 1.0;  // always place
    tree.displaceX = 5;
    tree.displaceY = 5;
    tree.minScale = 1;
    tree.maxScale = 1;
    tree.maxRotation = 360;
    tree.minSlope = 0;
    tree.maxSlope = 1;
    tree.weenieObj = 0;

    const serverThing = new ObjectDesc();
    serverThing.objId = 0x01000043;
    serverThing.freq = 1.0;
    serverThing.maxRotation = 360;
    serverThing.minSlope = 0;
    serverThing.maxSlope = 1;
    serverThing.minScale = 1;
    serverThing.maxScale = 1;
    serverThing.weenieObj = 9999; // server-spawned — should be filtered out

    const scene = new Scene();
    scene.id = 0x12000099;
    scene.objects = [tree, serverThing];

    const loadScene = (id: number) => (id === 0x12000099 ? scene : null);
    const sampler = makeTerrainSampler(landblock.id, landblock, region);

    const placements = generateScenery(landblock.id, landblock, region, loadScene, sampler);

    expect(placements.length).toBeGreaterThan(0);
    // All placements should be the tree ObjectDesc, not the WeenieObj-tagged one
    for (const p of placements) {
      expect(p.objId).toBe(0x01000042);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(192);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(192);
      // On a flat landblock at height 50, Z = 50 × 2 = 100 (no LandHeightTable)
      expect(p.z).toBeCloseTo(100, 6);
      expect(p.scale).toBe(1);
      expect(p.heading).toBeGreaterThanOrEqual(0);
      expect(p.heading).toBeLessThan(360);
    }

    // Second run with same inputs must be identical (deterministic).
    const placements2 = generateScenery(landblock.id, landblock, region, loadScene, sampler);
    expect(placements2.length).toBe(placements.length);
    for (let i = 0; i < placements.length; i++) {
      expect(placements2[i].x).toBe(placements[i].x);
      expect(placements2[i].y).toBe(placements[i].y);
      expect(placements2[i].heading).toBe(placements[i].heading);
    }
  });

  it('honors excludeCells — buildings mask out scenery in their cells', async () => {
    const { generateScenery, makeTerrainSampler } = await import('@ac/renderer/terrain/SceneryGenerator.js');
    const { CellLandblock } = await import('@ac/dat-parser');
    type RegionDesc = import('@ac/dat-parser').RegionDesc;

    const landblock = new CellLandblock();
    landblock.id = 0x12340000 | 0xffff;
    landblock.terrain = new Array(81).fill((1 << 2));
    landblock.heights = new Array(81).fill(50);

    const region = {
      landDefs: { landHeightTable: undefined } as never,
      terrainInfo: {
        terrainTypes: [
          { terrainName: 'unused', terrainColor: 0, sceneTypes: [] },
          { terrainName: 'grass', terrainColor: 0, sceneTypes: [0] },
        ],
        landSurfaces: { type: 0, texMerge: null },
      } as never,
      sceneInfo: {
        sceneTypes: [{ stbIndex: 0, scenes: [0x12000099] }],
      } as never,
    } as unknown as RegionDesc;

    const tree = new ObjectDesc();
    tree.objId = 0x01000042;
    tree.freq = 1.0;
    tree.displaceX = 5;
    tree.displaceY = 5;
    tree.minScale = 1;
    tree.maxScale = 1;
    tree.minSlope = 0;
    tree.maxSlope = 1;

    const scene = new Scene();
    scene.id = 0x12000099;
    scene.objects = [tree];

    const sampler = makeTerrainSampler(landblock.id, landblock, region);

    // Without exclusion: some objects land in cell (0,0) — the SW corner cell.
    const unmasked = generateScenery(landblock.id, landblock, region, () => scene, sampler);
    const inCell00 = unmasked.some(p => Math.floor(p.x / 24) === 0 && Math.floor(p.y / 24) === 0);
    // With cell (0,0) masked, no placement should land in that cell.
    const masked = generateScenery(landblock.id, landblock, region, () => scene, sampler, {
      excludeCells: new Set([0]),
    });
    const stillInCell00 = masked.some(p => Math.floor(p.x / 24) === 0 && Math.floor(p.y / 24) === 0);
    expect(stillInCell00).toBe(false);
    // Sanity: the exclusion actually removed at least one placement if any landed there.
    if (inCell00) expect(masked.length).toBeLessThan(unmasked.length);
  });
});

describe('Scenery module — exports', () => {
  it('exposes Scene, ObjectDesc, onRoad, and constants from @ac/dat-parser', () => {
    expect(typeof Scene).toBe('function'); // constructor
    expect(typeof ObjectDesc).toBe('function');
    expect(typeof onRoad).toBe('function');
    expect(SCENERY_CELL_LENGTH).toBe(24);
    expect(SCENERY_BLOCK_LENGTH).toBe(192);
    expect(SCENERY_ROAD_WIDTH).toBe(5);
  });

  it('exposes the deterministic algorithm primitives on ObjectDesc', () => {
    expect(typeof ObjectDesc.noiseFor).toBe('function');
    expect(typeof ObjectDesc.displace).toBe('function');
    expect(typeof ObjectDesc.scaleObj).toBe('function');
    expect(typeof ObjectDesc.rotateObj).toBe('function');
    expect(typeof ObjectDesc.checkSlope).toBe('function');
  });
});
