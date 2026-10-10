/**
 * PERF (2026-09-30) — retail-lit materials draw transparent cull-none
 * surfaces in ONE pass. three's default two-pass path for transparent
 * DoubleSide materials sets needsUpdate before each pass, re-running the
 * program lookup twice per object per frame (16,920 bumps/s measured at
 * Holtburg). Drives the real applyRetailLighting / makeParticleMaterial.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyRetailLighting } from '../packages/renderer/src/models/RetailLighting.js';
import { makeParticleMaterial } from '../packages/renderer/src/effects/ParticleSystem.js';

describe('single-pass transparent DoubleSide materials', () => {
  it('applyRetailLighting marks lit and unlit materials forceSinglePass', () => {
    const lit = applyRetailLighting(new THREE.MeshLambertMaterial({ transparent: true, side: THREE.DoubleSide }), 'landscape');
    const basic = applyRetailLighting(new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }), 'object');
    expect(lit.forceSinglePass).toBe(true);
    expect(basic.forceSinglePass).toBe(true);
  });

  it('particle materials (which go through applyRetailLighting) are single-pass', () => {
    const mat = makeParticleMaterial({ map: null, color: 0xffffff, opacity: 1, alphaTest: 0, additive: true, luminosity: 0 } as never, new THREE.Color(1, 1, 1), 'object');
    expect(mat.transparent).toBe(true);
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.forceSinglePass).toBe(true);
  });
});
