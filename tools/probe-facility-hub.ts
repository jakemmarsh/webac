/**
 * Facility Hub (0x8A02) view probe: enter the world, @teleloc to LOC (default
 * the hub end of beamed corridor 0x8A0201BC, beside the hub's west doorway
 * cell 0x8A0201C5) and screenshot the camera at each of YAWS.
 * OUT=<dir> AC_ACCOUNT=<own probe account> AC_BASE/AC_BRIDGE as usual.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, teleloc, sessionArgs } from './lib/game-session.js';
const OUT = process.env.OUT ?? 'verification/facility-hub';
const LOC = process.env.LOC ?? '0x8A0201C5 [55.4 -60 0.05] 1 0 0 0';
async function main() {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ ...sessionArgs(), createCharacter: process.env.AC_CHAR_NAME ?? 'Hubprobe', settleMs: 6000 });
  await teleloc(page, LOC, 15_000);
  const yaws = (process.env.YAWS ?? '1.571').split(',').map(Number);
  const info: unknown[] = [];
  for (const y of yaws) {
    await page.evaluate((v) => (window as any).acDebug?.setPlayerYaw?.(v), y);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/yaw-${y.toFixed(2)}.png` });
    info.push(await page.evaluate(() => (window as any).acDebug?.collisionState?.()));
  }
  writeFileSync(`${OUT}/info.json`, JSON.stringify(info, null, 2));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
