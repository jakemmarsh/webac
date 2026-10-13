/**
 * probe-cottage-arrival — teleport (@teleloc, admin account) and report when
 * the portal-space gate releases and LoginComplete goes out, on production
 * streamed DATs. Default destination: Far Horizon Cottages (0x7CF3001D, a
 * housing village), where Jake's hosted-connector session stayed in portal
 * space for ~6 min on 2026-10-12 (BUG.hidden-tab-teleport-loop).
 *
 *   AC_BASE=http://localhost:3017/ AC_BRIDGE=ws://localhost:9097 AC_ACCOUNT=stallprobe1 \
 *   AC_PASSWORD=stallprobe1 AC_URL_EXTRA='datSet=https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json' \
 *   [AC_HIDDEN=1|old] [AC_POLLS=20] npx tsx tools/probe-cottage-arrival.ts ['<cell> [x y z] qw qx qy qz']
 *
 * AC_HIDDEN=1 starves requestAnimationFrame the way a background tab does
 * (BackgroundTicker then steps the game on its worker beat); AC_HIDDEN=old
 * also no-ops GameUI.pumpTeleportLoop, i.e. the pre-fix client (never sends
 * LoginComplete). AC_POLLS = 2 s polls before giving up (default 60).
 * Results 2026-10-12: old 40 s+ never; fixed hidden 7.5 / 8 s; visible 7.6 s.
 */
import { enterWorld, gameUrl, teleloc, collisionState } from './lib/game-session.js';

const LOC = process.argv[2] ?? '0x7CF3001D [85.9 98.1 82] 1 0 0 0';
const extra = process.env.AC_URL_EXTRA;
const url = gameUrl({ cb: 'cottage' }) + (extra ? `&${extra}` : '');
const lines: string[] = [];
const { browser, page } = await enterWorld({
  url, createCharacter: process.env.AC_CHAR_NAME ?? 'Cottage Probe', timeoutMs: 360_000, settleMs: 5000,
  consoleFilter: /DatStream|LoginComplete|portal|Teleport/i,
});
page.on('console', (m) => lines.push(`${Date.now()} ${m.text()}`));
// AC_HIDDEN=1: starve requestAnimationFrame the way a background tab does
// (BackgroundTicker then steps the game on its worker beat). AC_HIDDEN=old
// also disables GameUI.pumpTeleportLoop, i.e. the pre-fix client.
if (process.env.AC_HIDDEN) {
  await page.evaluate(`(() => {
    window.requestAnimationFrame = () => 0;
    if (${JSON.stringify(process.env.AC_HIDDEN)} === 'old') window.__ac.gameUI.pumpTeleportLoop = () => {};
  })()`);
  await page.waitForTimeout(1000);
}
const t0 = Date.now();
await teleloc(page, LOC, 0);
for (let i = 0; i < Number(process.env.AC_POLLS ?? 60); i++) {
  await page.waitForTimeout(2000);
  const c = await collisionState(page).catch(() => null);
  const s = await page.evaluate('window.acDebug && window.acDebug.screen ? window.acDebug.screen() : null').catch(() => null);
  console.log(`+${((Date.now() - t0) / 1000).toFixed(0)}s loginComplete=${c?.loginComplete} x=${c?.x?.toFixed?.(1)} z=${c?.z?.toFixed?.(1)} screen=${JSON.stringify(s)}`);
  if (c?.loginComplete === true && i > 2) break;
}
for (const l of lines.filter((l) => /DatStream|LoginComplete|gate|Teleport|portal/i.test(l))) console.log(l);
await browser.close();
