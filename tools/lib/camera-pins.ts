/**
 * Camera-distance pins for the world-scene harnesses (capture-ui-screens
 * --scenes, sidebyside.ts, game-session applyWorldPins), as page JS.
 *
 * VISUAL.scorecard-world-town-framing — `CameraController.cameraDistance` is
 * a getter (the retail rig: CORE.18.b), so the old `c.cameraDistance = 18`
 * pin was silently dropped and `world-town-far` came out identical to
 * `world-town-day`. The pin now zooms through the player's own path: wheel
 * notches (`zoomBy`, one CameraSet::Farther tick each) until the boom reaches
 * the asked distance or retail refuses the next tick at CAMERA_FAR_LIMIT,
 * so a "far" scene shows what a retail player can see at full zoom-out and
 * never a boom retail could not reach.
 */

/** Ask for this to mean "as far as retail lets the camera go". */
export const ZOOM_FARTHEST = 1000;

/** Page JS: reset to the default boom, then zoom out notch by notch toward `distance`. Returns the boom length. */
export function cameraZoomToJs(distance: number): string {
  return '(() => { const c = window.__ac && window.__ac.cameraController; if (!c) return null;'
    + ' c.resetZoom();'
    + ` for (let i = 0; i < 200 && c.cameraDistance < ${distance}; i++) {`
    + ' const before = c.cameraDistance; c.zoomBy(1); if (c.cameraDistance === before) break; }'
    + ' return c.cameraDistance; })()';
}

/** Page JS: back to retail's default boom ("Move camera to default"). */
export const CAMERA_RESET_JS = '(() => { const c = window.__ac && window.__ac.cameraController; if (c) c.resetZoom(); })()';
