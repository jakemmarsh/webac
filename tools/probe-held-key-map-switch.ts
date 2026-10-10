/**
 * probe-held-key-map-switch — live check for MOVE.stuck-forward-after-map-switch.
 * Real keyboard events: hold ArrowUp (Move Forward), press+hold F2 (Toggle
 * Alternate Camera Mode → input map 6), release ArrowUp, release F2. The
 * player must stop moving. Also checks window blur releases a held W.
 * Usage: npx tsx tools/probe-held-key-map-switch.ts  (vite :3000 + bridge :9090 + ACE)
 */
import { enterWorld, sessionArgs } from './lib/game-session.js';
async function main(): Promise<void> {
  const session = await enterWorld({ ...sessionArgs(), cb: 'keymap', viewport: { width: 1280, height: 800 }, timeoutMs: 240_000, reloadEveryMs: 0 })
    .catch(() => { console.log('FAIL never in world'); process.exit(1); });
  const { browser, page } = session;
  await page.waitForTimeout(8000);
  await page.mouse.click(640, 300);
  const pos = async () => page.evaluate(`(() => { const c = window.acDebug.collisionState(); return { x: c.x, z: c.z, fwd: window.__ac.cameraController.isMovingForward }; })()`) as Promise<{ x: number; z: number; fwd: boolean }>;
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1500);
  const a = await pos();
  await page.keyboard.down('F2');
  await page.waitForTimeout(200);
  await page.keyboard.up('ArrowUp');
  await page.waitForTimeout(200);
  await page.keyboard.up('F2');
  await page.waitForTimeout(500);
  const b = await pos();
  await page.waitForTimeout(1500);
  const c = await pos();
  const drift = Math.hypot(c.x - b.x, c.z - b.z);
  console.log(`held ArrowUp moving: fwd=${a.fwd}`);
  console.log(`after ArrowUp released under F2: fwd=${c.fwd} drift over 1.5s=${drift.toFixed(2)}m`);
  // Blur: hold W, blur the window, W must release.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(500);
  await page.evaluate(`window.dispatchEvent(new Event('blur'))`);
  await page.waitForTimeout(300);
  const d = await pos();
  await page.keyboard.up('KeyW');
  console.log(`after blur with W held: fwd=${d.fwd}`);
  const ok = a.fwd && !c.fwd && drift < 0.05 && !d.fwd;
  console.log(ok ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
