/**
 * probe-landblock-statics — VISUAL.landblock-statics-missing-vs-retail.
 *
 * Teleports to ACE points of interest and lists the landblock statics and
 * buildings (LandblockInfo 0xXXYYFFFE) our client placed near the player,
 * with a screenshot per stop, so a missing object shows up as a DAT row with
 * no scene object.
 *
 *   npx tsx tools/probe-landblock-statics.ts [--poi Xarabydun,Outpost] [--create-char Name]
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, enterWorld, sessionArgs, shot, telepoi, readAc } from './lib/game-session.js';

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const pois = (arg('poi') ?? 'Xarabydun,Outpost').split(',');
const out = resolve(REPO, 'verification/landblock-statics');
mkdirSync(out, { recursive: true });

const s = await enterWorld({ ...sessionArgs(), cb: 'probe-lb-statics', settleMs: 4000, createCharacter: arg('create-char') });
try {
  for (const poi of pois) {
    await telepoi(s.page, poi, 25_000);
    const near = await readAc<unknown>(s.page, `(() => {
      const st = ac.landblockObjects; const cs = dbg.collisionState();
      const rows = [];
      for (const b of st.blocks.values()) {
        const groups = { static: b.staticEntries, building: b.buildingEntries, scenery: b.sceneryEntries || [] };
        for (const [kind, list] of Object.entries(groups)) for (const e of list) {
          const m = e.matrix.elements; const dx = m[12] - cs.x, dz = m[14] - cs.z;
          if (Math.hypot(dx, dz) < 40) rows.push({ blk: b.key.toString(16), shown: b.shown, kind, obj: e.objId.toString(16), dx: +dx.toFixed(1), dz: +dz.toFixed(1), y: +m[13].toFixed(1) });
        }
        for (const o of b.objects) { const p = o.position; const dx = p.x - cs.x, dz = p.z - cs.z;
          if (Math.hypot(dx, dz) < 40) rows.push({ blk: b.key.toString(16), shown: b.shown, kind: 'mesh', name: o.name, visible: o.visible, dx: +dx.toFixed(1), dz: +dz.toFixed(1), y: +p.y.toFixed(1) }); }
      }
      return { player: { x: cs.x, z: cs.z, feetY: cs.feetY }, rows };
    })()`);
    console.log(poi, JSON.stringify(near, null, 1));
    console.log('wrote', await shot(s.page, resolve(out, `${poi.toLowerCase()}.png`)));
  }
} finally {
  await s.browser.close();
}
