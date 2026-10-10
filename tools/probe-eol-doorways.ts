/**
 * BLDG.portal-face-drawn-over-interior — end-of-retail check: log in through
 * the URL path (AC_BASE / AC_BRIDGE / AC_ACCOUNT / AC_PASSWORD, game-session
 * gameUrl), then for each SPOTS entry "<@teleloc args>|<yaw>,<yaw>…" teleport
 * there and screenshot each heading. The account must be admin (@teleloc).
 *
 *   AC_BASE=http://localhost:3021/ AC_BRIDGE=ws://localhost:9193 AC_ACCOUNT=portalfix1 AC_PASSWORD=portalfix1pw \
 *     SPOTS='0xAAB30004 [19.0 84.0 117.0] 1 0 0 0|4.71;0xA9B40032 [155.4 27.0 95.0] 1 0 0 0|0' \
 *     npx tsx tools/probe-eol-doorways.ts <outdir>
 *
 * Those two spots face the Training Academy pyramid 0x010014C3 doorway at
 * 0xAAB3 (its portal face is solid blue) and building 0x01002232's doorway
 * in Holtburg (opaque black portal faces).
 */
import { join } from 'node:path';
import { enterWorld, shot, chatLine } from './lib/game-session.js';
const out = process.argv[2];
const { browser, page } = await enterWorld({ createCharacter: 'Portalfix', settleMs: 6000, viewport: { width: 1280, height: 720 } });
const ev = <T = unknown>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const spots = (process.env.SPOTS ?? '').split(';').filter(Boolean);
for (const [i, spot] of spots.entries()) {
  const [loc, yaws] = spot.split('|');
  await chatLine(page, `@teleloc ${loc}`);
  await page.waitForTimeout(14000);
  for (const y of yaws.split(',')) {
    await ev(`window.__ac.cameraController.playerYaw = ${y}; window.__ac.cameraController.cameraYawOffset = 0`);
    await page.waitForTimeout(2500);
    await shot(page, join(out, `spot${i}-yaw${y}.png`));
  }
}
await browser.close();
