/**
 * BUG.ui-text-blank-iosurface-exhaustion — 2D canvases default to CPU backing
 * so the UI's many small text canvases never exhaust macOS IOSurfaces (Jake's
 * 2026-10-03 session: "Failed to allocate IOSurface of size 18x16" in
 * chrome://gpu, every label blank, then the 3D view grey).
 */
import { describe, it, expect } from 'vitest';
import { installCpuBacked2dCanvases } from '../packages/renderer/src/ui/CanvasBacking.ts';

function fakeProto() {
  const calls: Array<{ id: string; options: unknown }> = [];
  const proto: { getContext: (id: string, options?: unknown) => unknown } & Record<symbol, unknown> = {
    getContext(id: string, options?: unknown) { calls.push({ id, options }); return { id }; },
  };
  return { proto, calls };
}

describe('installCpuBacked2dCanvases', () => {
  it("defaults '2d' contexts to willReadFrequently: true and keeps the caller's other options", () => {
    const { proto, calls } = fakeProto();
    expect(installCpuBacked2dCanvases(proto)).toBe(true);
    proto.getContext('2d');
    proto.getContext('2d', { alpha: false });
    expect(calls).toEqual([
      { id: '2d', options: { willReadFrequently: true } },
      { id: '2d', options: { alpha: false, willReadFrequently: true } },
    ]);
  });

  it('respects an explicit willReadFrequently: false (an accelerated canvas on purpose)', () => {
    const { proto, calls } = fakeProto();
    installCpuBacked2dCanvases(proto);
    proto.getContext('2d', { willReadFrequently: false });
    expect(calls[0].options).toEqual({ willReadFrequently: false });
  });

  it('leaves WebGL contexts alone and installs only once', () => {
    const { proto, calls } = fakeProto();
    installCpuBacked2dCanvases(proto);
    expect(installCpuBacked2dCanvases(proto)).toBe(false);
    proto.getContext('webgl2', { antialias: true });
    proto.getContext('2d');
    expect(calls).toEqual([
      { id: 'webgl2', options: { antialias: true } },
      { id: '2d', options: { willReadFrequently: true } },   // not wrapped twice
    ]);
  });
});
