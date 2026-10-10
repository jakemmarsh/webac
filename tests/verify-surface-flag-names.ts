/**
 * FAITHFUL.214 — `acDebug.inspectSurface` lesson from FAITHFUL.213.
 *
 * The ClipMap alpha-test bug took months to spot because there was no easy
 * way to see what SurfaceType flags were set on a given surface from the
 * console. The new `inspectSurface(id)` and surface-augmented
 * `inspectGfxObj(id)` helpers render Surface flags by name (Base1ClipMap,
 * Alpha, Translucent, …) so the next bug like this can be diagnosed in one
 * call.
 *
 * This test pins the underlying flag-name lookup pattern — that
 * `Object.entries(SurfaceType)` enumerates each named numeric value, so a
 * caller can match `surf.type & value` against every name in the enum.
 * If somebody later converts SurfaceType to a `const` object or `as const`
 * union, the iteration approach would silently return nothing and the
 * helper would degrade — this test fails before that ships.
 */
import { describe, it, expect } from 'vitest';
import { SurfaceType } from '@ac/dat-parser/file-types/Surface.js';

describe('FAITHFUL.214 — SurfaceType is iterable for flag-name diagnostics', () => {
  it('Object.entries(SurfaceType) yields every numeric flag at least once', () => {
    const entries = Object.entries(SurfaceType).filter(([, v]) => typeof v === 'number');
    // ACE SurfaceType has 13 flags total
    expect(entries.length).toBeGreaterThanOrEqual(13);

    const names = entries.map(([k]) => k);
    expect(names).toContain('Base1Solid');
    expect(names).toContain('Base1Image');
    expect(names).toContain('Base1ClipMap');
    expect(names).toContain('Translucent');
    expect(names).toContain('Diffuse');
    expect(names).toContain('Luminous');
    expect(names).toContain('Alpha');
    expect(names).toContain('InvAlpha');
    expect(names).toContain('Additive');
  });

  it('flag-by-name lookup classifies a typical foliage surface as ClipMap', () => {
    // Surface 0x080011ce (a pine-foliage surface): type = 0x04 = Base1ClipMap
    const type = SurfaceType.Base1ClipMap;
    const matched: string[] = [];
    for (const [name, value] of Object.entries(SurfaceType)) {
      if (typeof value === 'number' && (type & value) !== 0) matched.push(name);
    }
    expect(matched).toEqual(['Base1ClipMap']);
  });

  it('flag-by-name lookup handles composite flags (Base1Image | Translucent | Alpha)', () => {
    const type = SurfaceType.Base1Image | SurfaceType.Translucent | SurfaceType.Alpha;
    const matched: string[] = [];
    for (const [name, value] of Object.entries(SurfaceType)) {
      if (typeof value === 'number' && (type & value) !== 0) matched.push(name);
    }
    // Should match all three. (Order matches insertion order in the enum.)
    expect(matched).toContain('Base1Image');
    expect(matched).toContain('Translucent');
    expect(matched).toContain('Alpha');
    expect(matched.length).toBe(3);
  });
});
