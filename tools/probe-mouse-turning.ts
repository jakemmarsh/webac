/**
 * CORE.18.b.a.a.a.a.a.b — live probe of Use Mouse Turning.
 *
 * Turns the option on through the real option path (CharacterOption 0x31),
 * then with real Playwright mouse input: holds the RIGHT button over the
 * world and moves the mouse right — the PLAYER must turn (TurnLeft, retail
 * CameraSet::Rotate's non-keyboard branch) while the camera orbit stays put;
 * a still mouse stops the turn; the LEFT button (right still held) runs
 * forward; releasing both stops. @myloc then shows the server has the same
 * heading and position. The option is switched back off before exiting.
 *
 *   npx tsx tools/probe-mouse-turning.ts
 *
 * Output: verification/mouse-turning/{probe.json, *.png}
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import {
  REPO, sessionArgs, openSession, gameUrl, waitForWorld, telepoi, adminCommand, collisionState, shot,
} from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'mouse-turning');

let wsFrames: string[] = [];

/** @myloc's reply is drawn on the canvas chat, so read it off the wire. */
async function myloc(page: Page): Promise<{ cell: number; x: number; y: number; z: number; qw: number; qz: number } | null> {
  const RE = /Location: 0x([0-9A-F]{8}) \[(-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\] (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/;
  wsFrames.length = 0;
  await adminCommand(page, '@myloc', 'talk');
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const m = wsFrames.join('\n').match(RE);
    if (m) return { cell: parseInt(m[1], 16), x: +m[2], y: +m[3], z: +m[4], qw: +m[5], qz: +m[8] };
  }
  return null;
}

type Cam = { playerYaw: number; orbit: number; turnL: boolean; turnR: boolean; fwd: boolean; look: boolean; speed: number; x: number; z: number };
const cam = (page: Page): Promise<Cam> => page.evaluate(`(() => { const c = window.__ac.cameraController, s = window.acDebug.collisionState();
  return { playerYaw: c.playerYaw, orbit: c.cameraYawOffset, turnL: c.isTurningLeft, turnR: c.isTurningRight,
    fwd: c.isMovingForward, look: c.isMouseLookActive, speed: c.turnSpeed, x: s.x, z: s.z }; })()`) as Promise<Cam>;

async function setMouseTurning(page: Page, on: boolean): Promise<void> {
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.optionsSettings.useMouseTurning = ${on};
    ui.callbacks.onCharacterOptionToggle(0x31, ${on}); })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await openSession({ ...sessionArgs() });
  const { page } = s;
  page.on('websocket', (ws) => ws.on('framereceived', (f) => {
    const u = typeof f.payload === 'string' ? Buffer.from(f.payload, 'latin1') : f.payload;
    let t = ''; for (const b of u) t += (b >= 32 && b < 127) ? String.fromCharCode(b) : ' ';
    wsFrames.push(t);
  }));
  const url = gameUrl({ cb: 'mouse-turning' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!(await waitForWorld(page, { url }))) throw new Error('never entered world');
  await page.waitForTimeout(5000);
  const r: Record<string, unknown> = {};
  const vp = page.viewportSize()!;
  // A spot over the 3D world, clear of the HUD.
  const cx = Math.round(vp.width / 2), cy = Math.round(vp.height * 0.35);
  try {
    await telepoi(page, 'holtburg', 20_000, 'talk');
    await setMouseTurning(page, true);
    r.optionOn = await page.evaluate('window.__ac.cameraController.constructor.isMouseTurningEnabled()');
    await page.mouse.move(cx, cy);
    r.start = await cam(page);
    await shot(page, join(OUT, '1-start.png'));

    // Right held + mouse right: the player turns, the orbit does not.
    await page.mouse.down({ button: 'right' });
    r.rightHeld = await cam(page);
    for (let i = 0; i < 20; i++) { await page.mouse.move(cx + (i + 1) * 12, cy); await page.waitForTimeout(16); }
    r.turning = await cam(page);
    await page.waitForTimeout(600); // still > 0.2 s → the turn stops
    r.afterStill = await cam(page);
    await shot(page, join(OUT, '2-turned.png'));

    // Left pressed with the right still held: run forward.
    await page.mouse.down({ button: 'left' });
    await page.waitForTimeout(1500);
    r.leftRunning = await cam(page);
    await page.mouse.up({ button: 'left' });
    await page.waitForTimeout(300);
    r.leftReleased = await cam(page);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(1500);
    r.released = await cam(page);
    await shot(page, join(OUT, '3-ran.png'));

    const srv = await myloc(page);
    const local = await collisionState(page);
    r.server = srv;
    if (srv) {
      const sx = ((srv.cell >>> 24) & 0xff) * 192 + srv.x, sy = ((srv.cell >>> 16) & 0xff) * 192 + srv.y;
      r.positionGapMeters = +Math.hypot(local.x - sx, local.z - sy).toFixed(3);
      // AC heading from the server quaternion vs ours (scene/AcHeading: θ = π − yaw).
      const srvTheta = 2 * Math.atan2(srv.qz, srv.qw);
      const ourTheta = Math.PI - (local.playerYaw as number);
      const d = Math.atan2(Math.sin(srvTheta - ourTheta), Math.cos(srvTheta - ourTheta));
      r.headingGapDeg = +(d * 180 / Math.PI).toFixed(2);
    }
  } finally {
    await setMouseTurning(page, false).catch(() => {});
    await page.waitForTimeout(1500);
    r.optionRestored = await page.evaluate('!window.__ac.cameraController.constructor.isMouseTurningEnabled()').catch(() => null);
    writeFileSync(join(OUT, 'probe.json'), JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2));
    await s.browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
