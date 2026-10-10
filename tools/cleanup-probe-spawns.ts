/**
 * cleanup-probe-spawns — remove what live probes left standing in Holtburg:
 * @create'd chests, drudges, ground daggers / tapers / healing kits /
 * pyreal piles (dynamic guids only) around the two-client meet spot and the
 * vendor spot. Leftovers show up in other sessions' screen captures (a probe
 * chest once sat in every scene of a GPU screen-regression pass).
 * Logs in as an admin probe account (fxprobe1 by default).
 *
 * Usage: AC_BASE=http://localhost:3000/ npx tsx tools/cleanup-probe-spawns.ts [--radius m]
 */
import { adminCommand, deleteSpawnsNear, enterWorld, gameUrl } from './lib/game-session.ts';
import { MEET_LOC } from './lib/two-client.ts';

/** chest, Drudge Skulker (7), drudge (19257), pyreal, dagger, Prismatic Taper, Handy Healing Kit. */
export const PROBE_SPAWN_WCIDS = [143, 7, 19257, 273, 314, 20631, 628] as const;
const SPOTS = [MEET_LOC, '0xA9B40019 84.3 1.5 94 0.9969 0 0 -0.0785'];
const RADIUS = (() => { const i = process.argv.indexOf('--radius'); return i >= 0 ? Number(process.argv[i + 1]) : 60; })();
const account = process.env.AC_ACCOUNT ?? 'fxprobe1';

async function main(): Promise<void> {
  const s = await enterWorld({ settleMs: 3000, url: gameUrl({ cb: 'cleanup-spawns', env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: process.env.AC_PASSWORD ?? account } }) } as never);
  try {
    let total = 0;
    for (const spot of SPOTS) {
      await adminCommand(s.page, `@teleloc ${spot}`);
      await s.page.waitForTimeout(10_000);
      // Repeat until a pass removes nothing (objects stream in as the view settles).
      for (let pass = 0; pass < 4; pass++) {
        const n = await deleteSpawnsNear(s.page, PROBE_SPAWN_WCIDS, RADIUS);
        total += n;
        console.log(`${spot}: pass ${pass + 1} removed ${n}`);
        if (n === 0) break;
      }
    }
    console.log(`removed ${total} probe spawn(s)`);
  } finally {
    await s.browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
