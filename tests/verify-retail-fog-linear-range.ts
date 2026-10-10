/**
 * VISUAL.fog-sky-tint-towns — retail fog is D3D fixed-function LINEAR vertex
 * fog over the eye-to-vertex DISTANCE (RenderDeviceD3D::SetDefaultD3DStates
 * @ 005a3800: FOGTABLEMODE 0, FOGVERTEXMODE 3 = D3DFOG_LINEAR,
 * RANGEFOGENABLE 1). three.js's stock fog is smoothstep over view depth.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { installRetailFog, patchFogVertex, patchFogFragment, retailFogFactor } from '../packages/renderer/src/effects/RetailFog.js';

const DECOMP = 'reference/client-eol/decomp/acclient-decompiled.annotated.c';

describe('RetailFog — D3DFOG_LINEAR over the range', () => {
  it('the factor is linear between start and end (Clear day group 150–2400 m)', () => {
    expect(retailFogFactor(600, 150, 2400)).toBeCloseTo(0.2, 9);
    expect(retailFogFactor(1800, 150, 2400)).toBeCloseTo(0.7333, 3);
    expect(retailFogFactor(2000, 150, 2400)).toBeCloseTo(0.8222, 3);
    expect(retailFogFactor(100, 150, 2400)).toBe(0);
    expect(retailFogFactor(3000, 150, 2400)).toBe(1);
  });

  it('installs range distance + linear factor into three\'s chunks, idempotently, and every lit program includes them', () => {
    installRetailFog();
    installRetailFog();
    expect(THREE.ShaderChunk.fog_vertex).toContain('vFogDepth = length( mvPosition.xyz );');
    expect(THREE.ShaderChunk.fog_vertex).not.toContain('- mvPosition.z');
    expect(THREE.ShaderChunk.fog_fragment).toContain('clamp( ( vFogDepth - fogNear ) / ( fogFar - fogNear ), 0.0, 1.0 )');
    expect(THREE.ShaderChunk.fog_fragment).not.toContain('smoothstep');
    // The lambert shaders pull the chunks by #include at compile time.
    expect(THREE.ShaderLib.lambert.vertexShader).toContain('#include <fog_vertex>');
    expect(THREE.ShaderLib.lambert.fragmentShader).toContain('#include <fog_fragment>');
  });

  it('a missing anchor throws instead of silently keeping three\'s curve', () => {
    expect(() => patchFogVertex('vFogDepth = something;')).toThrow(/anchor/);
    expect(() => patchFogFragment('float fogFactor = 0.0;')).toThrow(/anchor/);
  });
});

describe.skipIf(!existsSync(DECOMP))('RetailFog — decomp pins (needs reference/client-eol)', () => {
  it('SetDefaultD3DStates sets FOGTABLEMODE none, FOGVERTEXMODE linear, RANGEFOGENABLE', () => {
    const src = readFileSync(DECOMP, 'utf8');
    const start = src.indexOf('// ===== RenderDeviceD3D::SetDefaultD3DStates @ 005a3800 =====');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('// =====', start + 10));
    expect(body).toContain('(this->m_pDirect3DDevice,0x23,0)');
    expect(body).toContain('(this->m_pDirect3DDevice,0x8c,3)');
    expect(body).toContain('(this->m_pDirect3DDevice,0x30,1)');
  });
});
