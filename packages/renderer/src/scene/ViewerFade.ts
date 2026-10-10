import * as THREE from 'three';
import { setObjectNoDraw } from '../effects/ObjectLights.js';

/**
 * CORE.18.b.a — the camera's translucency on the player's own model
 * (CameraSet::UpdateCamera → CPhysicsObj::SetTranslucencyHierarchical; see
 * RetailCamera.cameraPlayerTranslucency). 0 = opaque, 1 = invisible.
 *
 * The player's materials come from MaterialFactory's shared cache, so a
 * fade never writes to them: each faded mesh swaps in private clones
 * (kept on the mesh for reuse) and swaps the originals back at 0. Fully
 * translucent hides the model outright. Calls with an unchanged value do
 * nothing, like retail's "only when t changes" guard.
 */
interface FadeState {
  original: THREE.Material | THREE.Material[];
  faded: THREE.Material | THREE.Material[];
}

const FADE_KEY = 'viewerFade';
const LEVEL_KEY = 'viewerFadeLevel';

function cloneForFade(m: THREE.Material): THREE.Material {
  const c = m.clone();
  c.userData.viewerFadeBaseOpacity = m.opacity;
  c.transparent = true;
  return c;
}

export function applyViewerFade(root: THREE.Object3D, translucency: number): void {
  const t = Math.max(0, Math.min(1, translucency));
  if (root.userData[LEVEL_KEY] === t) return;
  root.userData[LEVEL_KEY] = t;
  root.visible = t < 1;
  // Fully faded = not drawn, still in the world: a held torch stays lit
  // (BUG.hidden-object-lights-leave-pool).
  setObjectNoDraw(root, t >= 1);
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.material) return;
    const state = child.userData[FADE_KEY] as FadeState | undefined;
    if (t <= 0 || t >= 1) {
      // Opaque (or hidden): the shared originals go back on.
      if (state && child.material === state.faded) child.material = state.original;
      return;
    }
    let s = state;
    if (!s || (child.material !== s.faded && child.material !== s.original)) {
      // First fade, or the mesh got new materials since (re-equip).
      const original = child.material as THREE.Material | THREE.Material[];
      s = {
        original,
        faded: Array.isArray(original) ? original.map(cloneForFade) : cloneForFade(original),
      };
      child.userData[FADE_KEY] = s;
    }
    const apply = (m: THREE.Material) => { m.opacity = (m.userData.viewerFadeBaseOpacity as number) * (1 - t); };
    if (Array.isArray(s.faded)) s.faded.forEach(apply); else apply(s.faded);
    child.material = s.faded;
  });
}

/** The fade level last applied to `root` (0 when never faded). */
export function viewerFadeLevel(root: THREE.Object3D): number {
  return (root.userData[LEVEL_KEY] as number | undefined) ?? 0;
}

/**
 * Run `fn` with `root`'s viewer fade lifted, then put it back. The paperdoll
 * clones the live player model; in first person (or with the camera pulled
 * into the head by walls) that model is hidden and no-draw, and the clone
 * came up blank (Jake, Coldeve 2026-10-10). The doll is retail's own object
 * (gmPaperDollUI::RedressCreature), never the camera's translucency.
 */
export function withoutViewerFade<T>(root: THREE.Object3D, fn: () => T): T {
  const level = viewerFadeLevel(root);
  if (level <= 0) return fn();
  applyViewerFade(root, 0);
  try { return fn(); } finally { applyViewerFade(root, level); }
}
