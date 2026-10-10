/**
 * STREAM.portal-tunnel-built-once — a cold first login can open the
 * portal-space tunnel before the world pack lands; PortalSpaceRenderer built
 * its teleport object and animation once per mount, so the tunnel stayed
 * empty or frozen for the whole wait. It now records a build that missed
 * streamed files and rebuilds it in place when they arrive (GameUI.
 * onStreamedFilesArrived), keeping the running animation's clock.
 *
 * THREE's WebGLRenderer is swapped for a stub (node has no WebGL).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { noteDatMiss } from '../packages/dat-parser/src/streaming/DatMiss.js';

vi.mock('three', async (importOriginal) => {
  const THREE = await importOriginal<typeof import('three')>();
  class StubRenderer {
    domElement = { style: {}, dataset: {} as Record<string, string> } as unknown as HTMLCanvasElement;
    setSize(): void {}
    setPixelRatio(): void {}
    setClearColor(): void {}
    render(): void {}
    dispose(): void {}
    forceContextLoss(): void {}
  }
  return { ...THREE, WebGLRenderer: StubRenderer };
});

describe('PortalSpaceRenderer under streaming', () => {
  beforeAll(() => {
    (globalThis as unknown as { window: unknown }).window ??= { devicePixelRatio: 1 };
  });

  it('a tunnel built without its teleport object gets it once the files arrive', async () => {
    const THREE = await import('three');
    const { PortalSpaceRenderer } = await import('../packages/renderer/src/effects/PortalSpaceRenderer.js');
    let resident = false;
    let builds = 0;
    const setupRenderer = {
      createSetupMesh: () => {
        builds++;
        if (!resident) { noteDatMiss(); return null; }
        const g = new THREE.Group();
        const part = new THREE.Group(); part.name = 'part_0'; g.add(part);
        return g;
      },
    };
    let now = 1000;
    const ps = new PortalSpaceRenderer(800, 600, setupRenderer as never, null);
    ps.clock = () => now;
    ps.startAnimation();
    expect(ps.incomplete).toBe(true);
    now = 3000; // the tunnel has been open 2 s
    resident = true;
    expect(ps.rebuildIfIncomplete()).toBe(true);
    expect(builds).toBe(2);
    expect(ps.incomplete).toBe(false);
    expect((ps as unknown as { object: unknown }).object).not.toBeNull();
    // Nothing missing any more: no further rebuilds.
    expect(ps.rebuildIfIncomplete()).toBe(false);
    expect(builds).toBe(2);
    ps.dispose();
  });

  it('a complete build is never redone', async () => {
    const THREE = await import('three');
    const { PortalSpaceRenderer } = await import('../packages/renderer/src/effects/PortalSpaceRenderer.js');
    let builds = 0;
    const ps = new PortalSpaceRenderer(800, 600, { createSetupMesh: () => { builds++; return new THREE.Group(); } } as never, null);
    expect(ps.incomplete).toBe(false);
    expect(ps.rebuildIfIncomplete()).toBe(false);
    expect(builds).toBe(1);
    ps.dispose();
  });
});
