import * as THREE from 'three';
import { applyRetailLighting, cellObjectBaseOf, cellObjectVariantOf, retailLightingKindOf } from './RetailLighting.js';

/**
 * REND.shared-cached-material-disposed-faded — who owns a material.
 *
 * MaterialFactory hands out ONE cached material per (surface, palette) to
 * every mesh that draws that surface (retail: the GfxObj's CSurface is shared
 * by every CPhysicsPart drawing it; a part only gets its own material through
 * `CPhysicsPart::CopyMaterial @ 0050d630`). So:
 *
 *  - disposing a mesh must never dispose a shared material (every other live
 *    mesh drawing that surface would re-upload / re-link its program), and
 *  - any per-object material write (death fade, hit flash, PhysicsScript
 *    luminous/diffuse/transparent tweens, translucency) must first give the
 *    part its own copy — the CopyMaterial rule — or it bleeds onto every
 *    object sharing the surface.
 *
 * Shared materials are registered here (a WeakSet, not userData, because
 * `Material.clone()` copies userData and a clone is by definition owned).
 * The `cellobject` variants RetailLighting caches per shared base
 * (cellObjectVariantOf) are shared too, and resolve through their base.
 * Everything else a mesh carries is owned by that mesh.
 */
const sharedMaterials = new WeakSet<THREE.Material>();

/** Register a material as shared (cache-owned); returns it for chaining. */
export function markSharedMaterial<T extends THREE.Material>(material: T): T {
  sharedMaterials.add(material);
  return material;
}

/** True when `material` belongs to a cache (MaterialFactory / a cached cellobject variant of one). */
export function isSharedMaterial(material: THREE.Material): boolean {
  return sharedMaterials.has(material) || sharedMaterials.has(cellObjectBaseOf(material));
}

/** Dispose the owned materials in a mesh's material slot; shared ones are left alone. */
export function disposeOwnedMaterials(material: THREE.Material | THREE.Material[] | null | undefined): void {
  if (!material) return;
  const mats = Array.isArray(material) ? material : [material];
  for (const m of mats) {
    if (!(m instanceof THREE.Material) || isSharedMaterial(m)) continue;
    m.dispose();
    // An owned `cellobject` variant was cloned from an owned base the mesh
    // no longer references — release that one too.
    const base = cellObjectBaseOf(m);
    if (base !== m && !isSharedMaterial(base)) base.dispose();
  }
}

/**
 * Free a removed subtree's GPU resources with the ownership rule above:
 * per-mesh geometry is disposed, owned materials are disposed, shared
 * materials are not. Instancer/pool output (`userData.sharedResources`)
 * shares its template geometry + materials, so only its instance buffer goes.
 */
export function disposeObjectTree(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child.userData.sharedResources) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
      return;
    }
    if (child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.Line) {
      child.geometry?.dispose();
      disposeOwnedMaterials(child.material as THREE.Material | THREE.Material[]);
    }
  });
}

/**
 * `CPhysicsPart::CopyMaterial` — the private copy a part writes to. A clone
 * drops `onBeforeCompile`, so the retail shading is re-applied in the same
 * pass the original draws in (same recipe as SelectionLighting.copyLitMaterial).
 */
function copyForMutation(m: THREE.Material, geometry?: THREE.BufferGeometry): THREE.Material {
  // FX.cell-swap-loses-script-material — a shared `cellobject` variant (an
  // object drawn in a cell) is copied as the variant of the part's OWN copy
  // of its base, so leaving the cell (setCellLighting → cellObjectBaseOf)
  // lands on that owned base, not back on the shared one or stuck in the
  // cell pass.
  const base = cellObjectBaseOf(m);
  if (base !== m) {
    const ownBase = applyRetailLighting(base.clone(), retailLightingKindOf(base) ?? 'object');
    return cellObjectVariantOf(ownBase, geometry);
  }
  return applyRetailLighting(m.clone(), retailLightingKindOf(m) ?? 'object');
}

/** Meshes whose shared materials were swapped for private copies: what they drew before, and the copies installed. */
const ownedCopies = new WeakMap<THREE.Mesh, { originals: THREE.Material | THREE.Material[]; copies: THREE.Material | THREE.Material[] }>();

/**
 * Clone-on-first-mutate: swap every SHARED material on `mesh` for a private
 * copy (owned materials are kept — they are already this mesh's own) and
 * return the materials that are now safe to write. The copies are owned, so
 * the object's normal teardown (disposeObjectTree) frees them; a caller that
 * restores the original state can hand them back with `releaseOwnedCopies`.
 */
export function ownMeshMaterials(mesh: THREE.Mesh): THREE.Material[] {
  const current = mesh.material as THREE.Material | THREE.Material[] | null | undefined;
  if (!current) return [];
  const list = Array.isArray(current) ? current : [current];
  if (!list.some(isSharedMaterial)) return list;
  const copiesList = list.map(m => (isSharedMaterial(m) ? copyForMutation(m, mesh.geometry) : m));
  const copies = Array.isArray(current) ? copiesList : copiesList[0];
  ownedCopies.set(mesh, { originals: current, copies });
  mesh.material = copies;
  return copiesList;
}

/**
 * Undo ownMeshMaterials once a transient effect (hit flash) has fully
 * restored the original look: the mesh draws the shared originals again and
 * the private copies are disposed. Only when the mesh still carries exactly
 * those copies — if something else has since swapped its material (selection
 * lighting's CopyMaterial, a re-equip), the copies stay as that mesh's owned
 * material and its teardown frees them.
 */
export function releaseOwnedCopies(mesh: THREE.Mesh): void {
  const rec = ownedCopies.get(mesh);
  if (!rec) return;
  ownedCopies.delete(mesh);
  if (mesh.material !== rec.copies) return;
  const orig = Array.isArray(rec.originals) ? rec.originals : [rec.originals];
  const cur = Array.isArray(rec.copies) ? rec.copies : [rec.copies];
  for (const m of cur) if (!orig.includes(m)) m.dispose();
  mesh.material = rec.originals;
}
