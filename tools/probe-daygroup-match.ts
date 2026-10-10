/**
 * Which DayGroup was the retail frame in? Render a retail-A/B town scene at a
 * fixed phase under every DayGroup and score the sky band against retail.png
 * (VISUAL.fog-sky-tint-towns). The phase comes from the scene's meta.json
 * (oursPhase, pinned on the server that took the retail frame); a fresh ACE's
 * clock drifts from that server, so the wall-clock pin cannot be redone here.
 *
 *   npx tsx tools/probe-daygroup-match.ts town-sawato [--phase 0.534] [--rows 0-200]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { enterWorld, gameUrl, REPO } from './lib/game-session.ts';
import { ACCOUNT, VIEWPORT } from './retail-ab-scenes.ts';

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
const scene = argv[0];
const dir = join(REPO, 'verification', 'retail-ab', scene);
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
const phase = Number(opt('--phase') ?? meta.oursPhase);
const [r0, r1] = (opt('--rows') ?? '0-200').split('-').map(Number);
const out = join(REPO, 'verification', 'fog-sky-tint', scene);
mkdirSync(out, { recursive: true });
const retail = PNG.sync.read(readFileSync(join(dir, 'retail.png')));

/** Sky-looking pixel: not green-dominant (foliage, grass) and not dark (trunks, roofs). */
const isSky = (d: Uint8Array | Buffer, i: number): boolean =>
  d[i + 2] + 8 >= d[i + 1] && d[i] + d[i + 1] + d[i + 2] > 300;

/**
 * Over rows r0..r1 (HUD corners excluded), the pixels that read as sky in BOTH
 * frames: their mean RGB here, retail's mean over the same pixels, and the
 * mean abs difference.
 */
function score(img: PNG): { mean: number[]; retail: number[]; diff: number; n: number } {
  const sum = [0, 0, 0]; const rs = [0, 0, 0]; let d = 0; let n = 0;
  for (let y = r0; y < r1; y++) for (let x = 120; x < img.width - 160; x++) {
    if (x > 700 && x < 900 && y < 60) continue;   // vitals
    const i = (y * img.width + x) * 4;
    if (!isSky(img.data, i) || !isSky(retail.data, i)) continue;
    for (let c = 0; c < 3; c++) { sum[c] += img.data[i + c]; rs[c] += retail.data[i + c]; d += Math.abs(img.data[i + c] - retail.data[i + c]); }
    n++;
  }
  const avg = (a: number[]): number[] => a.map((v) => Math.round(v / Math.max(n, 1)));
  return { mean: avg(sum), retail: avg(rs), diff: +(d / Math.max(n, 1) / 3).toFixed(1), n };
}

const { browser, page } = await enterWorld({
  viewport: { ...VIEWPORT }, settleMs: 4000, createCharacter: 'Obsprobe',
  url: gameUrl({ cb: 'daygroup', env: { ...process.env, AC_ACCOUNT: ACCOUNT, AC_PASSWORD: ACCOUNT, AC_URL: undefined } }),
});
try {
  const poi = scene.replace(/^town-/, '').replace(/-/g, ' ');
  await page.evaluate(`window.acDebug.sendChat(${JSON.stringify(`@telepoi ${poi}`)})`);
  await page.waitForTimeout(24_000);
  const groups = await page.evaluate(`window.__ac.skybox.skyDesc.dayGroups.map((g) => g.name ?? g.dayName ?? '')`) as string[];
  console.log(`${scene}: phase ${phase.toFixed(3)}, ${groups.length} day groups; sky rows ${r0}-${r1}`);
  const rows: string[] = [];
  for (let g = 0; g < groups.length; g++) {
    await page.evaluate(`window.acDebug.pinDayGroup(${g}); window.acDebug.freezeTimeOfDay(${phase});`);
    await page.waitForTimeout(2500);
    const img = PNG.sync.read(await page.screenshot());
    writeFileSync(join(out, `dg${g}.png`), PNG.sync.write(img));
    const s = score(img);
    rows.push(`dg${g} ${groups[g]}: ours ${JSON.stringify(s.mean)} retail ${JSON.stringify(s.retail)} diff ${s.diff} (${s.n} px)`);
    console.log(rows.at(-1));
  }
  writeFileSync(join(out, 'scores.txt'), `${scene} phase ${phase} rows ${r0}-${r1}\n${rows.join('\n')}\n`);
} finally {
  await browser.close().catch(() => {});
}
