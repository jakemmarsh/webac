import * as THREE from 'three';

/**
 * CORE.18 — the world is built in three.js space with AC (x, y, z) → three
 * (x, z, y): three +X = AC east, three +Z = AC north, three +Y = AC up.
 * Swapping two axes is a reflection (det −1), so a right-handed three.js
 * camera drew Dereth as its east-west mirror image: facing north, east
 * objects landed on the LEFT of the screen (retail draws them on the right —
 * ACE.Entity/Position.cs GetCurrentDir is right-handed Z-up, X east, Y north).
 *
 * The fix is ONE reflection at the end of the pipeline instead of a new
 * coordinate convention in every placement path: the world camera's
 * projection negates clip-space x. Rendering a reflected scene through a
 * reflected camera is exactly the true view, so every world-space consumer
 * (terrain, GfxObj/Setup, EnvCell, scenery, object frames, collision,
 * movement, radar, sound distance) keeps its numbers. Everything that maps
 * between the screen and the world through the camera — Raycaster
 * .setFromCamera, Vector3.project/unproject, Frustum.setFromProjectionMatrix —
 * reads projectionMatrix / projectionMatrixInverse, so picking and screen
 * probes follow the mirror with no further change.
 *
 * A reflected projection also reverses the screen-space winding of every
 * triangle, so a renderer drawing through a mirrored camera inverts its
 * front-face test (installMirrorAwareCulling). The mesh builders' own winding
 * reversal (GfxObjMesh / EnvCellRenderer "Y↔Z handedness flip") stays: the
 * geometry is still the reflected world, and its faces are front-facing for
 * exactly the same triangles as before.
 */

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);

/** userData key marking a camera whose projection carries the mirror. */
export const AC_MIRROR_X_KEY = 'acMirrorX';

/** True when `camera` draws through the CORE.18 world mirror. */
export function isMirroredCamera(camera: THREE.Camera | null | undefined): boolean {
  return !!camera && camera.userData?.[AC_MIRROR_X_KEY] === true;
}

/**
 * Make `camera` draw the (x,z,y)-built world the right way round: its
 * projection matrix — now and after every updateProjectionMatrix (resize, FOV
 * change) — is premultiplied by a clip-space x reflection. Idempotent.
 */
export function mirrorCameraX(camera: THREE.PerspectiveCamera): THREE.PerspectiveCamera {
  if (isMirroredCamera(camera)) return camera;
  camera.userData[AC_MIRROR_X_KEY] = true;
  const base = THREE.PerspectiveCamera.prototype.updateProjectionMatrix;
  camera.updateProjectionMatrix = function mirroredUpdateProjectionMatrix(this: THREE.PerspectiveCamera) {
    base.call(this);
    this.projectionMatrix.premultiply(MIRROR_X);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  };
  camera.updateProjectionMatrix();
  return camera;
}

/** The slice of THREE.WebGLRenderer the culling hook wraps. */
export interface MirrorCullingRenderer {
  renderBufferDirect: (
    camera: THREE.Camera, scene: THREE.Scene | null, geometry: THREE.BufferGeometry,
    material: THREE.Material, object: THREE.Object3D, group: unknown,
  ) => void;
  state: { setMaterial: (material: THREE.Material, frontFaceCW: boolean) => void };
}

const CULLING_INSTALLED = Symbol('acMirrorCulling');

/**
 * three.js picks the front face per draw from the OBJECT's handedness only
 * (WebGLRenderer.renderBufferDirect: frontFaceCW = matrixWorld.determinant()
 * < 0 → state.setMaterial → gl.frontFace). A mirrored camera flips every
 * triangle's screen winding, so for draws through one the front face is
 * inverted too. Draws through any other camera (UI previews, portal space)
 * are untouched. Idempotent.
 */
export function installMirrorAwareCulling(renderer: MirrorCullingRenderer): void {
  const tagged = renderer as unknown as Record<symbol, boolean>;
  if (tagged[CULLING_INSTALLED]) return;
  tagged[CULLING_INSTALLED] = true;

  let mirrored = false;
  // BUG.chargen-preview-blank — a context restore (WebGLRenderer
  // onContextRestore → initGLContext) replaces `renderer.state` with a new
  // WebGLState. Patching only the first one left every later frame culling
  // the mirrored world's FRONT faces: after a GPU reset the chargen figure
  // and the world drew inside out (the backs of the far polygons, flat and
  // dark). Patch whichever state object is current before each draw.
  const patched = new WeakSet<object>();
  const patchState = (): void => {
    const state = renderer.state;
    if (!state || patched.has(state)) return;
    patched.add(state);
    const setMaterial = state.setMaterial.bind(state);
    state.setMaterial = (material, frontFaceCW) => {
      setMaterial(material, mirrored ? !frontFaceCW : frontFaceCW);
    };
  };
  patchState();
  const renderBufferDirect = renderer.renderBufferDirect.bind(renderer);
  renderer.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
    patchState();
    mirrored = isMirroredCamera(camera);
    try {
      renderBufferDirect(camera, scene, geometry, material, object, group);
    } finally {
      mirrored = false;
    }
  };
}
