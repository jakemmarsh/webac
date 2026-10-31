/**
 * Buckets a CDP CPU-profile call frame into a coarse area for
 * tools/perf-profile.ts: how much of the main thread three.js takes (split
 * into draw submission, scene-graph matrix work and raycasting) versus the
 * game's own code by folder, GC and idle.
 */
export interface ProfileCallFrame { functionName: string; url: string }

/** three.js functions that run once per draw call (state, uniforms, VAOs). */
const THREE_DRAW = /^(WebGLRenderer\.)?(renderBufferDirect|renderObject|renderObjects|renderScene|setProgram|getProgram|setValue\w*|upload|refreshUniforms\w*|refreshFogUniforms|markUniforms\w*|setup|setupVertexAttributes|bindVertexArray|getBindingState|update|setMaterial|getParameters|getProgramCacheKey|push|unshift|sort|painterSortStable|reversePainterSortStable|finish|init)$/;
/** three.js scene-graph walk and matrix work. */
const THREE_GRAPH = /^(updateMatrixWorld|updateWorldMatrix|updateMatrix|compose|decompose|multiplyMatrices|multiply|premultiply|copy|setFromRotationMatrix|setFromMatrixPosition|setFromProjectionMatrix|traverse|traverseVisible|projectObject|intersectsObject|intersectsSphere|applyMatrix4|getWorldPosition|lookAt)$/;
const THREE_RAYCAST = /^(raycast|intersect\w*|intersectObject|intersectObjects|intersectTriangle|checkIntersection\w*|checkGeometryIntersection|intersectRay|intersectsBox|distanceSqToPoint)$/;

export function profileArea(f: ProfileCallFrame): string {
  const name = f.functionName;
  if (name === '(idle)') return 'idle';
  if (name === '(garbage collector)') return 'gc';
  if (name === '(program)') return 'browser (program)';
  if (/three(\.module|\.core)?(\.min)?\.js|\/three\/(src|build)\//.test(f.url)) {
    if (THREE_RAYCAST.test(name)) return 'three.js: raycast';
    if (THREE_GRAPH.test(name)) return 'three.js: scene graph';
    if (THREE_DRAW.test(name)) return 'three.js: draw submission';
    return 'three.js: other';
  }
  if (/\/node_modules\//.test(f.url)) return 'other deps';
  const pkg = /\/packages\/([^/]+)\//.exec(f.url);
  if (pkg && pkg[1] !== 'renderer') return `game: @ac/${pkg[1]}`;
  // Vite serves the renderer package from its root: /src/<folder>/File.ts.
  const m = /\/src\/(?:([^/?]+)\/)?[^/?]+\.ts/.exec(f.url);
  if (m) return `game: ${m[1] ?? '(root)'}`;
  if (!f.url) return 'native';
  return 'other';
}
