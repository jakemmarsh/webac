/**
 * probe-radar-monsters — BUG.radar-monsters-missing live check. Spawns a
 * Jade Gromnie (1614) and an Altered Drudge (7089) beside the probe
 * character, reads the monsters' wire radar fields and the HUD's radar dots,
 * crops the radar to verification/radar-monsters/, then @smite all.
 *
 * Needs an ADMIN account away from other players (monsters aggro):
 *   AC_ACCOUNT=radarprobe AC_PASSWORD=radarprobe npx tsx tools/probe-radar-monsters.ts
 */
import { enterWorld, adminCommand, shot } from './lib/game-session.js';
const OUT = 'verification/radar-monsters';

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'radar-monsters', settleMs: 5000 } as never);
  const { page } = s;
  await adminCommand(page, '@create 1614');
  await page.waitForTimeout(1500);
  await adminCommand(page, '@create 7089');
  await page.waitForTimeout(4000);
  const res = await page.evaluate(`(() => {
    const ac = window.__ac; const som = ac.serverObjectManager;
    const monsters = [...som.getAllObjects().values()].filter((o) => (o.itemType & 0x10) && !(o.objectDescFlags & 0x8))
      .map((o) => ({ name: o.name, wireColor: o.radarColor, behavior: o.radarBehavior, flags: o.objectDescFlags.toString(16) }));
    const dots = ac.gameUI.hudState.radarDots.map((d) => ({ name: d.name, color: d.color, shape: d.shape }));
    return JSON.stringify({ monsters, dots });
  })()`);
  console.log(res);
  const box = await page.evaluate(`(() => { const r = document.getElementById('radar-canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) as { x: number; y: number; w: number; h: number };
  await shot(page, `${OUT}/radar-crop.png`, { x: box.x - 10, y: box.y - 10, w: box.w + 20, h: box.h + 20 });
  await adminCommand(page, '@smite all');
  await page.waitForTimeout(2000);
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
