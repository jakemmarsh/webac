// @vitest-environment happy-dom
/**
 * VISUAL.container-open-selected-name — retail's VividTargetIndicator: the
 * selection triangles framing the selected object (retail frames
 * verification/retail-client/ab/retail-chest-selected.png and
 * retail-container-open.png), or an edge arrow when it is off screen.
 * Placement, angle bands, colourise and the DAT image rows are pinned to the
 * decompiled client (see the module header).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  VTI_MIN_DIST, VtiImage, VividTargetIndicatorView, colorizeRGBA, loadVtiImageDids,
  objectBoundingStatus, offscreenAngleDeg, offscreenImageForAngle, offscreenPosition,
  onScreenPlacement, vtiFrame, vtiShowsSelection, type RgbaImage, type VtiCamera,
} from '../packages/renderer/src/ui/VividTargetIndicator.js';
import { openDat } from './_harness/dat.js';

describe('VividTargetIndicator::OnDraw on-screen placement', () => {
  it('grows the object rect by one 12 px corner on every side', () => {
    expect(onScreenPlacement({ left: 700, top: 450, right: 870, bottom: 620 }, 1600, 900))
      .toEqual({ x: 688, y: 438, w: 194, h: 194 });
  });

  it('keeps min_dist (8 px) inside every viewport edge', () => {
    const p = onScreenPlacement({ left: -50, top: -40, right: 2000, bottom: 1200 }, 1600, 900);
    expect(p.x).toBe(VTI_MIN_DIST);
    expect(p.y).toBe(VTI_MIN_DIST);
    // right clamps to vw − 12 − 8, and the group adds one corner back
    expect(p.x + p.w).toBe(1600 - VTI_MIN_DIST);
    expect(p.y + p.h).toBe(900 - VTI_MIN_DIST);
  });

  it('a tiny object still gets a group at least two corners wide', () => {
    const p = onScreenPlacement({ left: 400, top: 300, right: 400, bottom: 300 }, 800, 600);
    expect(p).toEqual({ x: 388, y: 288, w: 24, h: 24 });
  });
});

describe('SmartBox::GetObjectBoundingBox off-screen heading', () => {
  it('reads clockwise from screen-up: up 0, right 90, down 180, left 270', () => {
    expect(offscreenAngleDeg(0, 1, 1)).toBeCloseTo(0, 6);
    expect(offscreenAngleDeg(1, 1, 0)).toBeCloseTo(90, 6);
    expect(offscreenAngleDeg(0, 1, -1)).toBeCloseTo(180, 6);
    expect(offscreenAngleDeg(-1, 1, 0)).toBeCloseTo(270, 6);
    expect(offscreenAngleDeg(1, 1, 1)).toBeCloseTo(45, 6);
  });

  it('at or behind the viewer only the side counts (atan2(0, x))', () => {
    expect(offscreenAngleDeg(0.3, -1, 5)).toBeCloseTo(90, 6);
    expect(offscreenAngleDeg(-0.3, -1, 5)).toBeCloseTo(270, 6);
  });

  it('a vector too small to normalise reads 0', () => {
    expect(offscreenAngleDeg(0, 0, 0)).toBe(0);
  });

  it('the 45° bands centred on the compass points pick the arrow image', () => {
    expect(offscreenImageForAngle(0)).toBe(VtiImage.OffscreenN);
    expect(offscreenImageForAngle(22.9)).toBe(VtiImage.OffscreenN);
    expect(offscreenImageForAngle(23)).toBe(VtiImage.OffscreenNE);
    expect(offscreenImageForAngle(90)).toBe(VtiImage.OffscreenE);
    expect(offscreenImageForAngle(135)).toBe(VtiImage.OffscreenSE);
    expect(offscreenImageForAngle(180)).toBe(VtiImage.OffscreenS);
    expect(offscreenImageForAngle(225)).toBe(VtiImage.OffscreenSW);
    expect(offscreenImageForAngle(270)).toBe(VtiImage.OffscreenW);
    expect(offscreenImageForAngle(315)).toBe(VtiImage.OffscreenNW);
    expect(offscreenImageForAngle(338)).toBe(VtiImage.OffscreenN);
  });

  it('the arrow rides the edge the heading crosses, min_dist inside', () => {
    const W = 1600, H = 900, S = 24;
    expect(offscreenPosition(0, W, H, S, S)).toEqual({ x: 788, y: 8 });
    expect(offscreenPosition(90, W, H, S, S)).toEqual({ x: W - 8 - S, y: 438 });
    expect(offscreenPosition(180, W, H, S, S)).toEqual({ x: 788, y: H - 8 - S });
    expect(offscreenPosition(270, W, H, S, S)).toEqual({ x: 8, y: 438 });
    // 45°: vh/2·tan(45) right of centre on the top edge; rad_conv
    // (0.017453292) leaves tan a hair under 1 and _ftol2 truncates → 1237
    expect(offscreenPosition(45, W, H, S, S)).toEqual({ x: 1237, y: 8 });
    // steep headings clamp into the corner
    expect(offscreenPosition(60, W, H, S, S).x).toBe(W - 8 - S);
    expect(offscreenPosition(60, W, H, S, S).y).toBe(8);
  });
});

describe('BlitOp_Colorize — the corners take the selection\'s blip colour', () => {
  const img: RgbaImage = { width: 2, height: 1, data: new Uint8Array([255, 255, 255, 255, 128, 64, 32, 100]) };

  it('white keeps each pixel as its own value, grey', () => {
    const out = colorizeRGBA(img, { r: 1, g: 1, b: 1, a: 1 });
    expect([...out.data]).toEqual([255, 255, 255, 255, 128, 128, 128, 100]);
  });

  it('gold tints by hue and saturation, keeping value and alpha', () => {
    const out = colorizeRGBA(img, { r: 1, g: 0.67, b: 0, a: 1 });
    expect([...out.data.slice(0, 4)]).toEqual([255, 171, 0, 255]);
    expect(out.data[4]).toBe(128);
    expect(out.data[6]).toBe(0);
    expect(out.data[7]).toBe(100);
  });
});

describe('VividTargetIndicator::SetSelected filter', () => {
  it('nothing for no selection, the player, owned or contained objects', () => {
    expect(vtiShowsSelection(0, 1, false, false)).toBe(false);
    expect(vtiShowsSelection(0x50000001, 0x50000001, false, false)).toBe(false);
    expect(vtiShowsSelection(0x80000010, 0x50000001, true, false)).toBe(false);
    expect(vtiShowsSelection(0x80000010, 0x50000001, false, true)).toBe(false);
    expect(vtiShowsSelection(0x80000010, 0x50000001, false, false)).toBe(true);
  });
});

/** A pinhole camera at the origin looking down +y, z up, 90° fov, no mirror. */
function testCamera(mirrorX = false): VtiCamera {
  const s = mirrorX ? -1 : 1;
  return {
    position: { x: 0, y: 0, z: 0 },
    right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 }, forward: { x: 0, y: 1, z: 0 },
    project: (p) => (p.y <= 0.1 ? null : { x: s * p.x / p.y, y: p.z / p.y }),
    sphereVisible: (c, r) => c.y + r > 0.1 && Math.abs(c.x) - r < c.y && Math.abs(c.z) - r < c.y,
  };
}

describe('SmartBox::GetObjectBoundingBox rect (Render::GetViewerBBox)', () => {
  it('a sphere ahead projects to a square rect about its centre', () => {
    const st = objectBoundingStatus({ x: 0, y: 10, z: 0 }, 1, testCamera(), 800, 800);
    expect(st).toEqual({ kind: 'onscreen', rect: { left: 360, top: 360, right: 440, bottom: 440 } });
  });

  it('an X-mirrored projection still yields left < right', () => {
    const st = objectBoundingStatus({ x: 2, y: 10, z: 0 }, 1, testCamera(true), 800, 800);
    expect(st.kind).toBe('onscreen');
    if (st.kind === 'onscreen') expect(st.rect.left).toBeLessThan(st.rect.right);
  });

  it('a sphere behind reads off screen with the side heading', () => {
    expect(objectBoundingStatus({ x: 5, y: -10, z: 0 }, 1, testCamera(), 800, 800))
      .toEqual({ kind: 'offscreen', angleDeg: 90 });
  });

  it('vtiFrame turns the status into the element placement', () => {
    const on = vtiFrame({ kind: 'onscreen', rect: { left: 360, top: 360, right: 440, bottom: 440 } }, 800, 800);
    expect(on).toEqual({ kind: 'onscreen', placement: { x: 348, y: 348, w: 104, h: 104 } });
    const off = vtiFrame({ kind: 'offscreen', angleDeg: 270 }, 800, 600);
    expect(off).toEqual({ kind: 'offscreen', image: VtiImage.OffscreenW, x: 8, y: 288 });
    expect(vtiFrame({ kind: 'none' }, 800, 600)).toEqual({ kind: 'hidden' });
  });
});

describe('VividTargetIndicatorView (DOM)', () => {
  const rows: number[] = [];
  const src = (row: number): RgbaImage => { rows.push(row); return { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) }; };
  const urls: string[] = [];
  const toUrl = (img: RgbaImage) => { const u = `data:x/${img.data.join('-')}`; urls.push(u); return u; };

  it('shows the four corners around the placement, recolouring only on a colour change', () => {
    document.body.innerHTML = '';
    const view = new VividTargetIndicatorView(document.body, '1', src, toUrl);
    const white = { r: 1, g: 1, b: 1, a: 1 };
    view.update({ kind: 'onscreen', placement: { x: 10, y: 20, w: 100, h: 50 } }, white);
    expect(view.onScreen.style.display).toBe('block');
    expect(view.onScreen.style.left).toBe('10px');
    expect(view.onScreen.style.width).toBe('100px');
    expect(view.offScreen.style.display).toBe('none');
    expect(rows).toEqual([1, 2, 3, 4]);
    expect(view.corners[3].style.right).toBe('0px');
    expect(view.corners[3].style.bottom).toBe('0px');
    expect(view.corners[0].style.backgroundImage).toContain('data:x/255-255-255-255');
    view.update({ kind: 'onscreen', placement: { x: 12, y: 20, w: 100, h: 50 } }, white);
    expect(rows).toEqual([1, 2, 3, 4]);
    view.update({ kind: 'onscreen', placement: { x: 12, y: 20, w: 100, h: 50 } }, { r: 1, g: 0.67, b: 0, a: 1 });
    expect(rows).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    expect(view.corners[0].style.backgroundImage).toContain('data:x/255-171-0-255');
  });

  it('switches to the off-screen arrow, then hides both', () => {
    document.body.innerHTML = '';
    rows.length = 0;
    const view = new VividTargetIndicatorView(document.body, '1', src, toUrl);
    view.update({ kind: 'offscreen', image: VtiImage.OffscreenW, x: 8, y: 288 }, { r: 1, g: 1, b: 1, a: 1 });
    expect(view.onScreen.style.display).toBe('none');
    expect(view.offScreen.style.display).toBe('block');
    expect(view.offScreen.style.top).toBe('288px');
    expect(rows).toEqual([VtiImage.OffscreenW]);
    view.update({ kind: 'hidden' }, { r: 1, g: 1, b: 1, a: 1 });
    expect(view.onScreen.style.display).toBe('none');
    expect(view.offScreen.style.display).toBe('none');
  });
});

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');

describe.skipIf(!existsSync(PORTAL))('VividTargetIndicator images against the EoL portal.dat', () => {
  let dids: number[] | null = null;
  let size: (did: number) => { w: number; h: number } | null;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    const db = openDat(PORTAL);
    dids = loadVtiImageDids(db, db.masterMapId);
    size = (did: number) => {
      const d = db.getFileData(did);
      if (!d) return null;
      const t = Texture.read(new DatReader(d)).toRGBA();
      return { w: t.width, h: t.height };
    };
  });

  it('master[0x10000009] rows 1..12 are Onscreen_NW..Offscreen_SE (0x06004c40..4b)', () => {
    expect(dids).not.toBeNull();
    for (let row = 1; row <= 12; row++) expect(dids![row]).toBe(0x06004c3f + row);
  });

  it('the corners fit the 12x12 elements and the arrows the 24x24 element', () => {
    expect(size(dids![VtiImage.OnscreenNW])).toEqual({ w: 12, h: 12 });
    expect(size(dids![VtiImage.OffscreenN])).toEqual({ w: 24, h: 24 });
  });
});
