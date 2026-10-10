/**
 * VISUAL.fog-sky-tint-towns — retail's fog curve.
 *
 * `RenderDeviceD3D::SetDefaultD3DStates` @ 005a3800 programs D3D fixed-
 * function vertex fog: D3DRS_FOGTABLEMODE (35) = D3DFOG_NONE, D3DRS_
 * FOGVERTEXMODE (140) = D3DFOG_LINEAR, D3DRS_RANGEFOGENABLE (48) = TRUE.
 * So the fog factor is LINEAR in the eye-to-vertex DISTANCE between the
 * start and end `SetFFFogProperties` sets from the sky keyframe.
 *
 * three.js's stock fog is smoothstep(near, far) on the view-axis DEPTH, which
 * under-fogs the middle distance and over-fogs the far hills (150–2400 m:
 * 0.10 vs 0.20 at 600 m, 0.92 vs 0.82 at 2000 m), and fogs less at the
 * screen edges than at the centre. Installed once at renderer start, before
 * any program compiles.
 */
import * as THREE from 'three';

const DEPTH_LINE = 'vFogDepth = - mvPosition.z;';
/** D3DRS_RANGEFOGENABLE: the distance from the eye, not the depth. */
const RANGE_LINE = 'vFogDepth = length( mvPosition.xyz );';
const SMOOTH_LINE = 'float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );';
/** D3DFOG_LINEAR: (d − start) / (end − start), clamped. */
const LINEAR_LINE = 'float fogFactor = fogFar > fogNear ? clamp( ( vFogDepth - fogNear ) / ( fogFar - fogNear ), 0.0, 1.0 ) : step( fogNear, vFogDepth );';

/** Rewrite the fog vertex chunk to range fog. Throws if three's anchor is gone. */
export function patchFogVertex(chunk: string): string {
  if (chunk.includes(RANGE_LINE)) return chunk;
  if (!chunk.includes(DEPTH_LINE)) throw new Error('RetailFog: fog_vertex anchor missing');
  return chunk.replace(DEPTH_LINE, RANGE_LINE);
}

/** Rewrite the fog fragment chunk to linear fog. Throws if three's anchor is gone. */
export function patchFogFragment(chunk: string): string {
  if (chunk.includes(LINEAR_LINE)) return chunk;
  if (!chunk.includes(SMOOTH_LINE)) throw new Error('RetailFog: fog_fragment anchor missing');
  return chunk.replace(SMOOTH_LINE, LINEAR_LINE);
}

/** Install retail's linear range fog into three's shader chunks (idempotent). */
export function installRetailFog(): void {
  THREE.ShaderChunk.fog_vertex = patchFogVertex(THREE.ShaderChunk.fog_vertex);
  THREE.ShaderChunk.fog_fragment = patchFogFragment(THREE.ShaderChunk.fog_fragment);
}

/** JS mirror of the installed fog factor: D3DFOG_LINEAR over the eye distance. */
export function retailFogFactor(distance: number, start: number, end: number): number {
  if (end <= start) return distance >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (distance - start) / (end - start)));
}
