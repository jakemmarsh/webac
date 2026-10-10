/**
 * SWEEP1006B.hud-status.radar-dial-blips-rotate-camera — the radar dial
 * follows the CHARACTER's heading, never the third-person camera orbit.
 *
 * Retail: gmRadarUI::UpdateCompassTokens @ 004d9060 reads
 * CPhysicsObj::get_heading(SmartBox::smartbox->player); gmRadarUI::DrawObjects
 * @ 004d9380 places blips via SmartBox::convert_to_player_space @ 00452da0
 * (Position::localtolocal against the player's m_position). Neither reads the
 * camera. Ours used CameraController.yaw (= playerYaw + cameraYawOffset), so
 * Rotate Camera / middle-mouse orbit spun the N/E/S/W tokens and every blip.
 *
 * Drives the real CameraController, the real radarHeadingRadians feed, the
 * real HUD.updateCompass, and the real token/blip placement functions.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { HUD } from '../packages/renderer/src/ui/HUD.js';
import { radarHeadingRadians, blipScreenPosition } from '../packages/renderer/src/ui/RadarBlips.js';
import { computeCompassTokenPositions } from '../packages/renderer/src/ui/RadarCompassTokens.js';

function dial(cc: CameraController) {
  const hud = new HUD();
  hud.updateCompass(radarHeadingRadians(cc));
  return {
    heading: hud.headingDegrees,
    tokens: computeCompassTokenPositions(hud.headingDegrees),
    // An object 20 m east of the player, radar range 75 m, radius 50 px, centre 60,60.
    blip: blipScreenPosition(20, 0, hud.headingDegrees, 75, 50, 60, 60),
  };
}

describe('radar dial follows the character heading, not the camera orbit', () => {
  it('orbiting the camera (cameraYawOffset) leaves tokens and blips unchanged', () => {
    const cc = new CameraController(new THREE.PerspectiveCamera(90, 1, 0.1, 1000));
    cc.playerYaw = Math.PI; // facing north
    cc.cameraYawOffset = 0;
    const before = dial(cc);
    expect(before.heading).toBe(0);

    cc.cameraYawOffset = 1.1; // third-person orbit
    expect(cc.yaw).not.toBe(cc.playerYaw);
    const after = dial(cc);
    expect(after).toEqual(before);
  });

  it('turning the character moves both the tokens and the blips', () => {
    const cc = new CameraController(new THREE.PerspectiveCamera(90, 1, 0.1, 1000));
    cc.playerYaw = Math.PI;
    const north = dial(cc);
    cc.playerYaw = Math.PI + Math.PI / 2; // turned 90 degrees
    const turned = dial(cc);
    expect(turned.heading).toBeCloseTo(90, 6);
    expect(turned.tokens).not.toEqual(north.tokens);
    expect(turned.blip).not.toEqual(north.blip);
    // Facing north, the east object sits right of centre; facing east it sits ahead (up).
    expect(north.blip!.x).toBeGreaterThan(60);
    expect(turned.blip!.y).toBeLessThan(60);
  });
});
