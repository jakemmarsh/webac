/**
 * probe-own-appearance — does the local player's model wear its ObjDesc
 * palettes by day, seen from the front? (Found 2026-10-03: after a barber
 * Apply the in-world hair read black while the barber preview showed ginger.)
 * Freezes noon (hair colour reads from behind too), screenshots the player,
 * and lists the player model's textures. Output: verification/own-appearance/.
 *
 * Usage: npx tsx tools/probe-own-appearance.ts   (AC_ACCOUNT default fxprobe3)
 */
import { mkdirSync } from 'node:fs';
import { enterWorld, gameUrl, shot } from './lib/game-session.ts';

const OUT = 'verification/own-appearance';
const ACCOUNT = process.env.AC_ACCOUNT ?? 'fxprobe3';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ settleMs: 6000, consoleFilter: /appearance|palette|ObjDesc/i,
    url: gameUrl({ cb: 'own-appearance', env: { ...process.env, AC_ACCOUNT: ACCOUNT, AC_PASSWORD: ACCOUNT } }) } as never);
  const page = s.page;
  try {
    await page.evaluate('window.acDebug.freezeTimeOfDay(0.5)');
    await page.waitForTimeout(3000);
    await shot(page, `${OUT}/back-noon.png`);
    const info = await page.evaluate(`(() => { const m = window.__ac.playerModel; const out = [];
      m && m.traverse((o) => { const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const x of mats) if (x.map && x.map.image) out.push({ part: o.parent && o.parent.name, w: x.map.image.width, h: x.map.image.height, name: x.map.name || '' }); });
      return out.slice(0, 40); })()`);
    console.log(JSON.stringify(info));
  } finally {
    await s.browser.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
