/**
 * RENDER.cell-particles-delayed-light-set (2026-10-10) — a particle draw
 * retail delays to the alpha list keeps the landscape light set (sun +
 * ambient) inside an env cell; only an opaque, non-fading one takes the
 * cell's pool lights.
 *
 * Retail: `D3DPolyRender::ConstructMesh` @ 0059dfa0 tags each batch by its
 * surface type (Alpha | InvAlpha | Additive → 2, Base1ClipMap → 8,
 * Translucent → 4, else 0). `DrawMesh` @ 0059d4a0 hands a batch whose tag is
 * in `s_AlphaDelayMask` (14), or any batch while the current CMaterial has
 * `has_alpha` (a fading particle's copied material), to `AddMeshToAlphaList`
 * @ 0059c230, which keeps no lights. `FlushAlphaList` @ 0059d2e0 runs after
 * `PView::DrawCells` @ 005a4840 restored `useSunlightSet(1)`.
 *
 * Drives the real ParticleSystem / particleDrawsFromDelayedList.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ParticleSystem, particleDrawsFromDelayedList, type ParticleFrameSource } from '../packages/renderer/src/effects/ParticleSystem.js';
import { fallbackParticleGfx, type ParticleSurface } from '../packages/renderer/src/effects/ParticleGfx.js';
import { retailLightingKindOf } from '../packages/renderer/src/models/RetailLighting.js';
import { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import { SurfaceType } from '@ac/dat-parser/file-types/Surface.js';

const surf = (over: Partial<ParticleSurface> = {}): ParticleSurface =>
  ({ map: null, additive: false, color: 0xffffff, opacity: 1, alphaTest: 0, luminosity: 0, ...over });

const info = (trans: Partial<{ startTrans: number; finalTrans: number; transRand: number }> = {}) =>
  Object.assign(Object.create(ParticleEmitterInfo.prototype), {
    id: 0x32000998, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0,
    birthrate: 0, maxParticles: 2, initialParticles: 2, totalParticles: 2, totalSeconds: 0,
    lifespan: 5, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0, b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
    c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0, startScale: 1, finalScale: 1, scaleRand: 0,
    startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0, ...trans,
  }) as ParticleEmitterInfo;

/** A one-surface particle GfxObj with the given DAT surface type. */
const gfxOfType = (type: number | undefined) => {
  const gfx = fallbackParticleGfx(1);
  gfx.gfxObjs[0][0].surface = { ...gfx.gfxObjs[0][0].surface, type, luminosity: 0,
    additive: type !== undefined && (type & SurfaceType.Additive) !== 0 };
  return gfx;
};

const frame = (inCell: () => boolean): ParticleFrameSource => ({
  offset: { x: 0, y: 0, z: 0 },
  getFrame: (p, q) => { p.set(0, 0, 0); q.identity(); return true; },
  inCell,
});

/** The light kind the system's draw uses outdoors, then inside a cell. */
function kindsOutThenIn(type: number | undefined, trans = {}): [string | undefined, string | undefined] {
  let inCell = false;
  const sys = new ParticleSystem(info(trans), 0xffffff, { gfx: gfxOfType(type) }, frame(() => inCell));
  const out = retailLightingKindOf(sys.meshes[0].material as THREE.Material);
  inCell = true;
  sys.update(0.016);
  const inside = retailLightingKindOf(sys.meshes[0].material as THREE.Material);
  sys.dispose();
  return [out, inside];
}

describe('particleDrawsFromDelayedList — ConstructMesh batch tags against s_AlphaDelayMask 14', () => {
  it('Alpha, InvAlpha and Additive surfaces (tag 2) are delayed', () => {
    for (const t of [SurfaceType.Alpha, SurfaceType.InvAlpha, SurfaceType.Additive]) {
      expect(particleDrawsFromDelayedList(surf({ type: SurfaceType.Base1Image | t }), false)).toBe(true);
    }
  });

  it('a Base1ClipMap surface (tag 8) and a Translucent one (tag 4) are delayed', () => {
    expect(particleDrawsFromDelayedList(surf({ type: SurfaceType.Base1ClipMap }), false)).toBe(true);
    expect(particleDrawsFromDelayedList(surf({ type: SurfaceType.Base1Image | SurfaceType.Translucent }), false)).toBe(true);
  });

  it('an opaque surface (tag 0) is drawn in place unless the emitter fades (material has_alpha)', () => {
    expect(particleDrawsFromDelayedList(surf({ type: SurfaceType.Base1Image }), false)).toBe(false);
    expect(particleDrawsFromDelayedList(surf({ type: SurfaceType.Base1Solid }), false)).toBe(false);
    expect(particleDrawsFromDelayedList(surf({ type: SurfaceType.Base1Image }), true)).toBe(true);
  });

  it('the synthetic fallback square (Base1Image | Alpha) is delayed', () => {
    expect(particleDrawsFromDelayedList(surf(), false)).toBe(true);
  });
});

describe('ParticleSystem in an env cell picks the light set by the delay rule', () => {
  it('an opaque, non-fading particle swaps to the cell pass (pool lights)', () => {
    expect(kindsOutThenIn(SurfaceType.Base1Image)).toEqual(['object', 'cellobject']);
  });

  it('an additive glow keeps the landscape set (sun + ambient) inside the cell', () => {
    expect(kindsOutThenIn(SurfaceType.Base1Image | SurfaceType.Additive)).toEqual(['object', 'object']);
  });

  it('an alpha smoke and a clip-map leaf keep the landscape set inside the cell', () => {
    expect(kindsOutThenIn(SurfaceType.Base1Image | SurfaceType.Alpha)).toEqual(['object', 'object']);
    expect(kindsOutThenIn(SurfaceType.Base1ClipMap)).toEqual(['object', 'object']);
  });

  it('an opaque surface on a fading emitter keeps the landscape set (the copied material has alpha)', () => {
    expect(kindsOutThenIn(SurfaceType.Base1Image, { finalTrans: 1 })).toEqual(['object', 'object']);
    expect(kindsOutThenIn(SurfaceType.Base1Image, { transRand: 0.2 })).toEqual(['object', 'object']);
  });

  it('a mixed chain switches only its in-place draw', () => {
    const gfx = gfxOfType(SurfaceType.Base1Image);
    const glow = gfxOfType(SurfaceType.Base1Image | SurfaceType.Additive);
    gfx.gfxObjs[0].push(glow.gfxObjs[0][0]);
    let inCell = false;
    const sys = new ParticleSystem(info(), 0xffffff, { gfx }, frame(() => inCell));
    inCell = true;
    sys.update(0.016);
    expect(sys.meshes.map(m => retailLightingKindOf(m.material as THREE.Material))).toEqual(['cellobject', 'object']);
    inCell = false;
    sys.update(0.016);
    expect(sys.meshes.map(m => retailLightingKindOf(m.material as THREE.Material))).toEqual(['object', 'object']);
    sys.dispose();
  });
});
