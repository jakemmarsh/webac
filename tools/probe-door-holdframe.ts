/**
 * probe-door-holdframe — live check for BUG.holdframe-cycle-renders-frame-zero:
 * a Holtburg house door (0x7A9B4003, motion table 0x09000202: On = anim
 * 0x03000C20 held at frame 29, Off = frame 0, ±30 fps links) must hold its
 * open frame after Use, and swing (not snap) shut on the next Use.
 * Usage: npx tsx tools/probe-door-holdframe.ts  (vite :3000 + bridge :9090 + ACE)
 */
import { join } from 'node:path';
import { REPO, openSession, gameUrl, sessionArgs, shot, teleloc, waitForWorld } from './lib/game-session.js';
const OUT = join(REPO, 'verification', 'door-holdframe');
const DOOR = 0x7a9b4003;
async function main(): Promise<void> {
  const { browser, page } = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await page.goto(gameUrl({ cb: 'door' }), { waitUntil: 'domcontentloaded' });
  await waitForWorld(page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await page.waitForTimeout(6000);
  await teleloc(page, '0xA9B4001E 73.1 127.5 66', 20_000);
  const frame = () => page.evaluate(`(() => { const a = window.__ac.serverObjectManager.getAnimated(${DOOR}); if (!a) return null;
     const mm = a.motionManager; return { frame: mm.animationPlayer.currentFrameIndex, stance: '0x' + (mm.stance >>> 0).toString(16) }; })()`) as Promise<{ frame: number; stance: string } | null>;
  console.log('door before use:', JSON.stringify(await frame()));
  // The first Use can be spent walking into use range (ACE MoveTo); retry
  // until the door leaves its closed pose.
  for (let tries = 0; tries < 4; tries++) {
    await page.evaluate(`window.acDebug.useObject(${DOOR})`);
    await page.waitForTimeout(250);
    const f = await frame();
    if (f && (f.frame !== 0 || f.stance === '0x3d000b')) break;
    await page.waitForTimeout(2500);
  }
  const openSeq: string[] = [];
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(300); const f = await frame(); openSeq.push(f ? `${f.frame}` : 'null'); }
  console.log('open  (frame every 300 ms):', openSeq.join(' '), JSON.stringify(await frame()));
  await shot(page, join(OUT, 'door-open.png'));
  await page.evaluate(`window.acDebug.useObject(${DOOR})`);
  const closeSeq: string[] = [];
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(150); const f = await frame(); closeSeq.push(f ? `${f.frame}` : 'null'); }
  console.log('close (frame every 200 ms):', closeSeq.join(' '), JSON.stringify(await frame()));
  await shot(page, join(OUT, 'door-closed.png'));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
