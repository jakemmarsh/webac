/**
 * probe-scenery-popin — BUG.scenery-pop-in-order (Jake 2026-09-30: "small
 * ones pop in right next to me while big ones in the distance are already
 * visible"). Runs the player through Holtburg's wooded outskirts on the real
 * GPU and samples every pooled scenery/static instance each ~150 ms: an
 * instance that becomes DRAWN while already within NEAR m of the player is a
 * near pop-in. Reports their distances, GfxObjs and degrade levels, plus how
 * many drawn instances lie beyond 150 m (the far trees).
 * Usage: npx tsx tools/probe-scenery-popin.ts [--near 40]
 */
import { enterWorld, adminCommand } from './lib/game-session.ts';
const NEAR = Number(process.argv[process.argv.indexOf('--near') + 1]) || 40;
const { browser, page } = await enterWorld({ gpu: true });
let done = false; page.on('console', (m) => { if (/Sent LoginComplete/.test(m.text())) done = true; });
await adminCommand(page, '@teleloc 0xA9B30020 [70 70 60] 1 0 0 0'); for (let i = 0; i < 90 && !done; i++) await page.waitForTimeout(500); await page.waitForTimeout(4000);
await page.mouse.click(780, 250);
const SNAP = `(() => { const a = window.__ac; const p = window.acDebug.collisionState(); const out = [];
  for (const [poolName, pool] of [['scenery', a.sceneryPool], ['statics', a.staticsPool]]) {
    for (const fam of pool.families.values()) {
      for (let i = 0; i < fam.count; i++) {
        const x = fam.master[i * 16 + 12], z = fam.master[i * 16 + 14];
        const drawn = fam.lod ? fam.lod.chain.levelIds[fam.lod.levels[i]] !== 0 : true;
        const d = Math.hypot(x - p.x, z - p.z);
        out.push([poolName[0] + fam.gfxObjId.toString(16) + '@' + Math.round(x) + ',' + Math.round(z), drawn ? 1 : 0, +d.toFixed(1), fam.lod ? fam.lod.levels[i] : -1]);
      }
    }
  }
  return JSON.stringify(out); })()`;
const state = new Map<string, number>();
const pops: string[] = []; let far = 0;
await page.keyboard.down('KeyW');
for (let t = 0; t < 80; t++) {
  if (t % 20 === 10) { await page.keyboard.down('KeyD'); await page.waitForTimeout(400); await page.keyboard.up('KeyD'); }
  const rows = JSON.parse(await page.evaluate(SNAP) as string) as Array<[string, number, number, number]>;
  far = rows.filter((r) => r[1] && r[2] > 150).length;
  for (const [key, drawn, d, lvl] of rows) {
    const was = state.get(key);
    if (was === 0 && drawn === 1 && d < NEAR) pops.push(`${key} d=${d} lvl=${lvl} t=${t}`);
    if (was === undefined && drawn === 1 && d < NEAR && t > 0) pops.push(`${key} NEW d=${d} lvl=${lvl} t=${t}`);
    state.set(key, drawn);
  }
  await page.waitForTimeout(150);
}
await page.keyboard.up('KeyW');
console.log(`near pop-ins (<${NEAR} m): ${pops.length}; drawn instances beyond 150 m at the end: ${far}`);
const hist: Record<string, number> = {};
for (const p of pops) { const d = Number(/d=([0-9.]+)/.exec(p)![1]); const b = Math.floor(d / 10) * 10; hist[b + '-' + (b + 10)] = (hist[b + '-' + (b + 10)] || 0) + 1; }
console.log('appearance distance histogram (m):', JSON.stringify(hist));
console.log(pops.slice(0, 12).join('\n'));
await browser.close();
