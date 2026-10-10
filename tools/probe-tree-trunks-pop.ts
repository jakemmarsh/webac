/**
 * probe-tree-trunks-pop — live check for BUG.tree-trunks-pop.
 *
 * Logs in, @telepoi Holtburg, and counts the DRAWN pooled instances of each
 * part of the two common Holtburg trees. A tree's parts share one cell
 * distance and identical degrade distances, so every trunk drawn must have
 * its canopy drawn and vice versa:
 *   Setup 0x02000258: trunk 0x0100379F (chain 0x1100001C, levels 0 and 1 =
 *     the same GfxObj) vs canopy 0x010037A1 (chain 0x1100001E)
 *   Setup 0x020002D3: trunk 0x01003AB6 (chain 0x11000C96, same shape) vs
 *     canopy 0x01003AB5 (chain 0x11000C87)
 * Before the fix the trunk totals were far below the canopy totals (the
 * level-1 rows overwrote the level-0 rows in the shared meshes).
 *
 * Usage: AC_ACCOUNT=testacjs3 AC_PASSWORD=testacjs3 npx tsx tools/probe-tree-trunks-pop.ts
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { REPO, enterWorld, sessionArgs, shot, telepoi } from './lib/game-session.js';

const COUNT_JS = `(() => {
  const want = { '0100379f': 'trunk258', '010037a1': 'canopy258', '01003ab6': 'trunk2d3', '01003ab5': 'canopy2d3' };
  const out = { trunk258: 0, canopy258: 0, trunk2d3: 0, canopy2d3: 0 };
  const seen = new Set();
  window.__ac.sceneManager.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.visible || !o.name.startsWith('sceneryinst_')) return;
    const m = /^sceneryinst_([0-9a-f]{8})(_lod\\d+)?$/.exec(o.name);
    if (!m || !want[m[1]]) return;
    // one submesh per mesh set (every submesh of a set holds the same rows)
    const set = o.name;
    if (seen.has(set)) return;
    seen.add(set);
    out[want[m[1]]] += o.count;
  });
  return out;
})()`;

async function main(): Promise<void> {
  const OUT = join(REPO, 'verification', 'tree-trunks-pop');
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ ...sessionArgs() });
  try {
    await telepoi(page, 'holtburg');
    const counts = await page.evaluate(COUNT_JS);
    console.log(JSON.stringify(counts));
    console.log('screenshot', await shot(page, join(OUT, 'holtburg.png')));
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
