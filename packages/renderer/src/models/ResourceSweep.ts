import * as THREE from 'three';

/**
 * PERF.browser-memory-crash — what the renderer's caches may release.
 *
 * Jake's browser ran out of memory on an M3 Max during normal play. A real-
 * GPU soak (tools/perf-soak.ts, 2026-09-30) showed GPU textures climbing
 * 828 → 3,448 and geometries 1,582 → 4,827 across eight teleports while the
 * JS heap stayed flat after GC: the caches (MaterialFactory, TextureManager,
 * the scenery instancer's templates) and the instance pools kept every
 * resource any landblock ever used. Retail's DBCache releases objects
 * nothing references; this is the browser equivalent.
 *
 * `collectLiveResources` walks the scene roots and returns every material,
 * texture and geometry a live object still references. The caches drop and
 * dispose only what is NOT in that set, so nothing drawn changes. Disposing
 * a three.js resource that something outside the roots still holds (the
 * portal-space or chargen scenes) is safe: three re-uploads it from its
 * retained CPU data on that object's next render.
 */
export interface LiveResources {
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
  geometries: Set<THREE.BufferGeometry>;
}

function addTexturesOf(value: unknown, out: Set<THREE.Texture>): void {
  if (!value || typeof value !== 'object') return;
  if ((value as THREE.Texture).isTexture) { out.add(value as THREE.Texture); return; }
  if (Array.isArray(value)) { for (const v of value) addTexturesOf(v, out); }
}

/** Every texture a material reads: its own texture slots and any shader uniforms. */
export function texturesOfMaterial(material: THREE.Material, out: Set<THREE.Texture>): void {
  for (const key of Object.keys(material)) addTexturesOf((material as unknown as Record<string, unknown>)[key], out);
  const uniforms = (material as THREE.ShaderMaterial).uniforms;
  if (uniforms) for (const u of Object.values(uniforms)) addTexturesOf(u?.value, out);
}

export function collectLiveResources(roots: Iterable<THREE.Object3D>): LiveResources {
  const live: LiveResources = { materials: new Set(), textures: new Set(), geometries: new Set() };
  for (const root of roots) {
    if ((root as THREE.Scene).isScene) {
      const scene = root as THREE.Scene;
      addTexturesOf(scene.background, live.textures);
      addTexturesOf(scene.environment, live.textures);
    }
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry && (mesh.geometry as THREE.BufferGeometry).isBufferGeometry) live.geometries.add(mesh.geometry as THREE.BufferGeometry);
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        if (!m || live.materials.has(m)) continue;
        live.materials.add(m);
        texturesOfMaterial(m, live.textures);
      }
    });
  }
  return live;
}
