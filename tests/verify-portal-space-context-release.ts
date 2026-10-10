/**
 * Portal space must release its WebGL context when it is torn down.
 *
 * Found live (tools/probe-spell-projectile.ts full run, 2026-09-28): after
 * ~16 teleports Chrome logged "Too many active WebGL contexts. Oldest context
 * will be lost." and THREE "Context Lost" — the oldest context is the game
 * world's canvas, which rendered white for the rest of the session. Each
 * teleport mounts a fresh PortalSpaceRenderer (GameUI.mountPortalSpaceTunnel)
 * whose WebGLRenderer.dispose() frees THREE's GPU objects but not the
 * context; forceContextLoss() releases it.
 *
 * Drives the shipped PortalSpaceRenderer with THREE's WebGLRenderer swapped
 * for a recorder (node has no WebGL).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const calls: string[] = [];
let created = 0;

vi.mock('three', async (importOriginal) => {
  const THREE = await importOriginal<typeof import('three')>();
  class RecordingRenderer {
    domElement = { style: {}, dataset: {} as Record<string, string> } as unknown as HTMLCanvasElement;
    constructor() { created++; }
    setSize(): void {}
    setPixelRatio(): void {}
    setClearColor(): void {}
    render(): void {}
    dispose(): void { calls.push('dispose'); }
    forceContextLoss(): void {
      // ContextHealth must be able to tell this deliberate release from a fault.
      calls.push(this.domElement.dataset.acIntentionalLoss === '1' ? 'forceContextLoss' : 'forceContextLoss-unmarked');
    }
  }
  return { ...THREE, WebGLRenderer: RecordingRenderer };
});

describe('PortalSpaceRenderer.dispose — releases its WebGL context', () => {
  beforeAll(() => {
    (globalThis as unknown as { window: unknown }).window ??= { devicePixelRatio: 1 };
  });

  it('every mount/unmount cycle frees its renderer AND its context', async () => {
    const { PortalSpaceRenderer } = await import('../packages/renderer/src/effects/PortalSpaceRenderer.js');
    for (let i = 0; i < 20; i++) new PortalSpaceRenderer(1568, 775).dispose();
    expect(created).toBe(20);
    expect(calls.filter((c) => c === 'forceContextLoss')).toHaveLength(20);
    // dispose() first (THREE frees its programs/textures while the context is live), then the context.
    expect(calls.slice(0, 2)).toEqual(['dispose', 'forceContextLoss']);
  });
});
