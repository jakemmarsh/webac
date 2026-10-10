import * as THREE from 'three';
import { ownMeshMaterials } from './MaterialOwnership.js';
import { CELL_LIGHTING_KEY, SCRIPT_MATERIAL_KEY, setCellLighting, setMaterialLuminosity } from './RetailLighting.js';
import { inheritPartTranslucency, partMeshes } from './ObjectTranslucency.js';

/**
 * RENDER.lazy-lod-misses-state — the material state a CPhysicsPart carries
 * for ALL its degrade levels. Retail's part draws every level GfxObj through
 * one surface array and one CMaterial (CPhysicsPart::SetGfxObjArray
 * @ 0050e2e0), so a luminosity / diffuse / translucency set on the part, or
 * the cell-vs-landscape light set its object is drawn under, applies to a
 * level the moment it is drawn. Our degrade levels are separate meshes built
 * on first use (DegradeLod), so they replay that state here.
 */

/** userData key on a part: the last CPhysicsPart::SetLuminosity / SetDiffusion values (script hooks). */
export const PART_SCRIPT_MATERIAL_KEY = 'acScriptPartMaterial';
export interface PartScriptMaterial { luminous?: number; diffuse?: number }

/**
 * Write a luminous / diffuse value into meshes' own material copies
 * (REND.shared-cached-material-disposed-faded — CPhysicsPart::CopyMaterial:
 * a MaterialFactory-shared material is never written in place).
 */
export function applyMaterialValueToMeshes(kind: 'luminous' | 'diffuse', meshes: readonly THREE.Mesh[], value: number): void {
  for (const mesh of meshes) {
    for (const mat of ownMeshMaterials(mesh)) {
      // Remembered on the material too: the cell / landscape pass swap
      // carries it to the other pass's material (setCellLighting).
      mat.userData[SCRIPT_MATERIAL_KEY] = { ...(mat.userData[SCRIPT_MATERIAL_KEY] as object | undefined), [kind]: value };
      if (kind === 'luminous') {
        // CPhysicsPart::SetLuminosity @ 0050e5f0 → CMaterial::SetLuminositySimple:
        // Emissive = grey(value) (VISUAL.lifestone-crystal-glow).
        if (mat instanceof THREE.MeshLambertMaterial) setMaterialLuminosity(mat, value);
      } else if ('color' in mat) {
        (mat as THREE.MeshBasicMaterial).color.setScalar(value);
      }
    }
  }
}

/** Set a part's luminosity / diffuse on everything it draws now, and remember it for levels built later. */
export function setPartMaterialValue(kind: 'luminous' | 'diffuse', part: THREE.Object3D, value: number): void {
  const rec = (part.userData[PART_SCRIPT_MATERIAL_KEY] as PartScriptMaterial | undefined) ?? {};
  rec[kind] = value;
  part.userData[PART_SCRIPT_MATERIAL_KEY] = rec;
  applyMaterialValueToMeshes(kind, partMeshes(part), value);
}

/** The light set (`true` = cell pass) the nearest ancestor-or-self of `node` was switched to, if any. */
function cellLightingOf(node: THREE.Object3D): boolean | undefined {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) {
    const v = n.userData[CELL_LIGHTING_KEY] as boolean | undefined;
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * Bring a level holder built after the fact (`built`, about to be added to
 * `part`) to the part's current state: its object's light set, the part's
 * translucency / no-draw, and any script luminosity / diffuse. `siblings`
 * are the part's existing meshes (its level-0 base).
 */
export function inheritPartState(part: THREE.Object3D, built: THREE.Object3D, siblings: readonly THREE.Object3D[]): void {
  // CORE.17.q.b — the cell pass's `cellobject` variants (setCellLighting);
  // the landscape pass is the base material every mesh is built with.
  if (cellLightingOf(part) === true) setCellLighting(built, true, true);
  const meshes = partMeshes(built);
  const rec = part.userData[PART_SCRIPT_MATERIAL_KEY] as PartScriptMaterial | undefined;
  if (rec?.luminous !== undefined) applyMaterialValueToMeshes('luminous', meshes, rec.luminous);
  if (rec?.diffuse !== undefined) applyMaterialValueToMeshes('diffuse', meshes, rec.diffuse);
  inheritPartTranslucency(part, built, siblings);
}
