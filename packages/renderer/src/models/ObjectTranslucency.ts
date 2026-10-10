import * as THREE from 'three';
import { ownMeshMaterials } from './MaterialOwnership.js';
import { inheritRetailLighting } from './RetailLighting.js';

/**
 * DECOMP.transparent-tween-clobbers — an object's translucency, the way
 * retail's CPhysicsObj / CPhysicsPart / CMaterial hold it.
 *
 *  - CPhysicsObj::SetTranslucencyInternal @ 0050f960 clamps the value to
 *    `translucencyOriginal` (the PhysicsDesc Translucency the server sent;
 *    set_description @ :267607) and hands it to every PART
 *    (CPartArray::SetTranslucencyInternal @ 00518340) — the object's own
 *    parts, never the objects it holds (children are SetTranslucencyHierarchical
 *    only).
 *  - CPhysicsPart::SetTranslucency @ 0050e670: 1.0 sets the part's no-draw
 *    bit (the material is left as it is); any other value clears it and, when
 *    the value is the GfxObj material's own (CurSettingsAreDefault @ 0050d9e0 —
 *    0), RestoreMaterial @ 0050df70 drops the part's copy so it draws exactly
 *    as authored again; otherwise CopyMaterial + CMaterial::SetTranslucencySimple
 *    @ 005396f0 writes the MATERIAL alpha (1 − t), which D3D modulates with the
 *    surface's own alpha — a translucent surface stays proportionally
 *    translucent, it is never forced opaque.
 *
 * Each material's authored opacity / transparent flag is recorded the first
 * time a part's copy is written, so the default restores exactly that.
 */

/** userData key on an object root: its current translucency (CPhysicsObj::translucency). */
export const TRANSLUCENCY_KEY = 'acTranslucency';
/** userData key on an object root: the server's translucency floor (CPhysicsObj::translucencyOriginal). */
export const TRANSLUCENCY_ORIGINAL_KEY = 'acTranslucencyOriginal';
/** userData key on a part node: CPhysicsPart::curTranslucency. */
const PART_TRANSLUCENCY_KEY = 'acPartTranslucency';
/**
 * userData key on a part's mesh: not drawn at translucency 1 (the part's
 * draw_state bit 1). SWEEP1006 part no-draw — the flag lives on the part's
 * own mesh, never on its material: a cached material is shared by every
 * object drawing that surface (MaterialFactory), so hiding it hid them all.
 */
export const PART_UNDRAWN_KEY = 'acPartUndrawn';
/**
 * userData key on a part node: the part's own draw_state bit 1 (set at
 * translucency 1). Kept on the part so a part that has no meshes yet (a
 * streamed GfxObj not resident) still carries it to its rebuilt successor.
 */
const PART_HIDDEN_KEY = 'acPartHidden';

/**
 * userData key on an object root: its CPhysicsObj::state (PhysicsState),
 * kept current by ServerObjectManager. Only the Cloaked bit is read here.
 */
export const PHYSICS_STATE_KEY = 'acPhysicsState';
/** PhysicsState.Cloaked. */
const STATE_CLOAKED = 0x100000;

/** The part's CPhysicsObj is Cloaked (a `part_N` node's owner is its parent group). */
function ownerCloaked(part: THREE.Object3D): boolean {
  const owner = /^part_\d+$/.test(part.name) ? part.parent : part;
  const state = owner?.userData[PHYSICS_STATE_KEY] as number | undefined;
  return state !== undefined && (state & STATE_CLOAKED) !== 0;
}

/** DEFAULT_TRANSLUCENCY (globals.tsv): a part with this value draws its authored material. */
export const DEFAULT_TRANSLUCENCY = 0;

interface AuthoredAlpha {
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
  alphaTest: number;
  blending: THREE.Blending;
}
const AUTHORED_KEY = 'acAuthoredAlpha';

/**
 * The object's CPhysicsPart nodes: its setup group's DIRECT `part_N`
 * children (a wielded item's own `part_N` never counts). An anchor with no
 * part children (a bare mesh) is its own single part.
 */
export function objectParts(root: THREE.Object3D): THREE.Object3D[] {
  const parts = root.children.filter(c => /^part_\d+$/.test(c.name));
  return parts.length > 0 ? parts : [root];
}

/** The object's part `index` (a direct `part_N` child), or null. */
export function objectPart(root: THREE.Object3D, index: number): THREE.Object3D | null {
  const name = `part_${index >>> 0}`;
  for (const c of root.children) if (c.name === name) return c;
  return null;
}

/**
 * The meshes a part draws itself — not the objects attached to it (a
 * wielded item is a child CPhysicsObj on the CHILDLIST, tagged
 * `userData.wieldedGuid`).
 */
export function partMeshes(part: THREE.Object3D, out: THREE.Mesh[] = []): THREE.Mesh[] {
  const walk = (n: THREE.Object3D): void => {
    if (n !== part && n.userData.wieldedGuid !== undefined) return;
    if (n instanceof THREE.Mesh) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(part);
  return out;
}

function authoredOf(mat: THREE.Material): AuthoredAlpha {
  let a = mat.userData[AUTHORED_KEY] as AuthoredAlpha | undefined;
  if (!a) {
    a = { opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite, alphaTest: mat.alphaTest, blending: mat.blending };
    mat.userData[AUTHORED_KEY] = a;
  }
  return a;
}

/**
 * A copy of `mat` drawing its AUTHORED look: drawn, at the surface's own
 * opacity/transparency, whatever translucency the world object is at. For
 * views that show the object independently of its world state — retail's
 * paperdoll is a fresh CPhysicsObj copy (gmPaperDollUI::RedressCreature @
 * 004a3bc0), so a Hidden/fading player (login, portal) still appears whole.
 * The caller owns (and disposes) the copy; textures stay shared.
 */
export function authoredMaterialCopy(mat: THREE.Material): THREE.Material {
  const copy = mat.clone();
  inheritRetailLighting(mat, copy);
  copy.visible = true;
  const a = mat.userData[AUTHORED_KEY] as AuthoredAlpha | undefined;
  if (a) restoreAuthored(copy, a);
  return copy;
}

/** CPhysicsPart::SetTranslucency @ 0050e670 on one part (a no-op while its object is Cloaked). */
export function setPartTranslucency(part: THREE.Object3D, value: number): void {
  // `physobj == NULL || (physobj->state & 0x100000) == 0`: a Cloaked
  // object's parts keep whatever they show (the object's own translucency
  // value is still recorded by setObjectTranslucency).
  if (ownerCloaked(part)) return;
  const t = Math.max(0, Math.min(1, value));
  const meshes = partMeshes(part);
  if (t === 1) {
    // CPhysicsPart::SetTranslucency @ 0050e670: draw_state |= 1 — the PART is
    // not drawn; its material is untouched (and may be shared).
    part.userData[PART_HIDDEN_KEY] = true;
    for (const mesh of meshes) { mesh.visible = false; mesh.userData[PART_UNDRAWN_KEY] = true; }
    return;
  }
  delete part.userData[PART_HIDDEN_KEY];
  const cur = (part.userData[PART_TRANSLUCENCY_KEY] as number | undefined) ?? DEFAULT_TRANSLUCENCY;
  for (const mesh of meshes) {
    if (mesh.userData[PART_UNDRAWN_KEY]) { mesh.visible = true; delete mesh.userData[PART_UNDRAWN_KEY]; }
  }
  if (cur === t) return;
  part.userData[PART_TRANSLUCENCY_KEY] = t;
  for (const mesh of meshes) {
    if (t === DEFAULT_TRANSLUCENCY) {
      // RestoreMaterial: the authored look.
      for (const m of materialsOf(mesh)) {
        const a = m.userData[AUTHORED_KEY] as AuthoredAlpha | undefined;
        if (a) restoreAuthored(m, a);
      }
      continue;
    }
    applyFadeToMeshes([mesh], t);
  }
}

/**
 * CopyMaterial + SetTranslucencySimple: material alpha 1 − t over the
 * surface's own. The copy's `has_alpha` (CMaterial::CheckAlphaValues
 * @ 005396a0: any alpha below 1) then makes D3DPolyRender::SetSurface
 * @ 0059c4d0 draw the part SRCALPHA/INVSRCALPHA with the alpha test off and
 * depth writes off (`local_8 = false`), whatever the surface's own flags —
 * a fading clip-map or opaque part must not keep occluding what is behind it.
 */
function applyFadeToMeshes(meshes: THREE.Mesh[], t: number): void {
  for (const mesh of meshes) {
    for (const m of ownMeshMaterials(mesh)) {
      const a = authoredOf(m);
      if (!m.transparent || m.alphaTest !== 0) m.needsUpdate = true;
      m.opacity = a.opacity * (1 - t);
      // A surface already blending without an alpha test (alpha, additive,
      // translucent) keeps its factors; an opaque or alpha-tested one is
      // switched to SRCALPHA/INVSRCALPHA (SetSurface's has_alpha branch).
      if (!a.transparent || a.alphaTest > 0) m.blending = THREE.NormalBlending;
      m.transparent = true;
      m.depthWrite = false;
      m.alphaTest = 0;
    }
  }
}

/**
 * FX.part-script-state-lost-on-rebuild — a part node rebuilt as `to` (a
 * streamed GfxObj arriving, the local player's in-place part transplant)
 * keeps `from`'s CPhysicsPart translucency state: retail swaps only the
 * part's GfxObj (CPartArray::SetPart @ 00518580 → CPhysicsPart::SetPart
 * @ 0050e700), so curTranslucency and the draw_state bit stay on the part.
 */
export function carryPartTranslucency(from: THREE.Object3D, to: THREE.Object3D): void {
  const cur = (from.userData[PART_TRANSLUCENCY_KEY] as number | undefined) ?? DEFAULT_TRANSLUCENCY;
  const curTo = (to.userData[PART_TRANSLUCENCY_KEY] as number | undefined) ?? DEFAULT_TRANSLUCENCY;
  const hidden = from.userData[PART_HIDDEN_KEY] === true;
  const hiddenTo = to.userData[PART_HIDDEN_KEY] === true;
  if (cur !== curTo || (hiddenTo && !hidden)) setPartTranslucency(to, cur);
  if (hidden && !hiddenTo) setPartTranslucency(to, 1);
}

function restoreAuthored(m: THREE.Material, a: AuthoredAlpha): void {
  if (m.opacity !== a.opacity || m.transparent !== a.transparent || m.alphaTest !== a.alphaTest
    || m.depthWrite !== a.depthWrite || m.blending !== a.blending) m.needsUpdate = true;
  m.opacity = a.opacity;
  m.transparent = a.transparent;
  m.depthWrite = a.depthWrite;
  m.alphaTest = a.alphaTest;
  m.blending = a.blending;
}

/**
 * RENDER.lazy-lod-misses-state — the part state a mesh built AFTER the
 * part's translucency was set must start from: retail's degrade levels
 * share the part's one CMaterial (CPhysicsPart::SetGfxObjArray), so a level
 * drawn later is faded / undrawn exactly like the others.
 */
export function inheritPartTranslucency(part: THREE.Object3D, built: THREE.Object3D, siblings: readonly THREE.Object3D[]): void {
  const meshes = partMeshes(built);
  // A part hidden before it had meshes carries the bit on the part node (PART_HIDDEN_KEY).
  if (part.userData[PART_HIDDEN_KEY] === true || siblings.some(o => o.userData[PART_UNDRAWN_KEY] || hasUndrawnMesh(o))) {
    for (const mesh of meshes) { mesh.visible = false; mesh.userData[PART_UNDRAWN_KEY] = true; }
  }
  const t = part.userData[PART_TRANSLUCENCY_KEY] as number | undefined;
  if (t !== undefined && t !== DEFAULT_TRANSLUCENCY) applyFadeToMeshes(meshes, t);
}

/** A part's own mesh is undrawn (a held copy on it is its own object, partMeshes). */
function hasUndrawnMesh(o: THREE.Object3D): boolean {
  return partMeshes(o).some((n) => n.userData[PART_UNDRAWN_KEY]);
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  const m = mesh.material as THREE.Material | THREE.Material[] | null | undefined;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

/**
 * CPhysicsObj::SetTranslucencyInternal @ 0050f960: clamp to the object's
 * translucencyOriginal, remember it, and set every part. Returns the value used.
 */
export function setObjectTranslucency(root: THREE.Object3D, value: number): number {
  const floor = (root.userData[TRANSLUCENCY_ORIGINAL_KEY] as number | undefined) ?? DEFAULT_TRANSLUCENCY;
  const t = Math.max(0, Math.min(1, value < floor ? floor : value));
  root.userData[TRANSLUCENCY_KEY] = t;
  for (const part of objectParts(root)) setPartTranslucency(part, t);
  return t;
}

/**
 * The server's Translucency (set_description @ :267600): it becomes the
 * object's `translucencyOriginal` — the floor every later fade clamps to —
 * and the object's translucency.
 */
export function setServerTranslucency(root: THREE.Object3D, value: number): void {
  const t = Math.max(0, Math.min(1, value));
  root.userData[TRANSLUCENCY_ORIGINAL_KEY] = t;
  setObjectTranslucency(root, t);
}

/**
 * `CPhysicsObj::MorphToExistingObject` @ 0050fab0 on a detached clone (the
 * examine portrait, BUG.examine-copies-live-pose): the copy takes the
 * source's `translucencyOriginal` — the server's floor — as both its
 * translucency and its own floor, never the live fade (a player examined
 * while portaling in drew blank). Every mesh under `root` gets its own
 * {@link authoredMaterialCopy}, the cloned per-part fade state is dropped,
 * and the floor is applied. Returns the copies; the caller disposes them.
 */
export function morphTranslucencyToOriginal(root: THREE.Object3D): THREE.Material[] {
  const copies: THREE.Material[] = [];
  drawAllParts(root);
  root.traverse((o) => {
    delete o.userData[PART_TRANSLUCENCY_KEY];
    delete o.userData[PART_HIDDEN_KEY];
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const copy = (m: THREE.Material) => { const c = authoredMaterialCopy(m); copies.push(c); return c; };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copy) : copy(mesh.material);
  });
  const original = (root.userData[TRANSLUCENCY_ORIGINAL_KEY] as number | undefined) ?? DEFAULT_TRANSLUCENCY;
  root.userData[TRANSLUCENCY_KEY] = original;
  if (original !== DEFAULT_TRANSLUCENCY) setObjectTranslucency(root, original);
  return copies;
}

/**
 * A copy drawing the object whole (the paperdoll, the examine figure): the
 * parts the live object has at translucency 1 are drawn again (their
 * PART_UNDRAWN_KEY meshes shown). The materials are the caller's business.
 */
export function drawAllParts(root: THREE.Object3D): void {
  root.traverse((o) => {
    delete o.userData[PART_HIDDEN_KEY];
    if (!o.userData[PART_UNDRAWN_KEY]) return;
    o.visible = true;
    delete o.userData[PART_UNDRAWN_KEY];
  });
}
