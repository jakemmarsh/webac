/**
 * probe-wielded-teleport-orphan — BUG.wielded-item-left-behind-on-teleport.
 *
 * Jake (2026-10-06): a Focusing Stone stayed on the ground after the player
 * wielding it portaled away; it examined fine until the wielder was gone,
 * then "unknown". Two clients: B wields a Focusing Stone (wcid 8904, a Held
 * caster with LightingOn) next to A, then teleports far away. A is checked
 * before / during / after for anything still drawing the stone: its own
 * ServerObject mesh in the scene and visible, or a `wielded_*` held copy
 * reachable from the scene.
 *
 * Usage: npx tsx tools/probe-wielded-teleport-orphan.ts   (env: tools/lib/two-client.ts)
 * Writes verification/wielded-teleport-orphan/{results.json,*.png}.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { adminCommand, shot } from './lib/game-session.ts';
import { openTwoClients } from './lib/two-client.ts';

const OUT = 'verification/wielded-teleport-orphan';
const FOCUSING_STONE = 8904;
/** Far from MEET_LOC (Yaraq). */
const AWAY_LOC = '0x7D64000D [36.0 101.0 0.005] 1 0 0 0';

/** Everything in A's world that could draw the stone. */
const stoneState = (page: Page, stone: number, wielder: number) => page.evaluate(`(() => {
  const ac = window.__ac; const som = ac.serverObjectManager; const scene = ac.sceneManager.scene;
  const reachable = (o) => { let live = true; for (let p = o; p; p = p.parent) { if (p === scene) return { inScene: true, live }; if (!p.visible) live = false; } return { inScene: false, live }; };
  const pos = (o) => { const v = o.getWorldPosition(new o.position.constructor()); return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)]; };
  const so = som.getObject(${stone}); const w = som.getObject(${wielder});
  const copies = []; scene.traverse((o) => { if (o.name && o.name.startsWith('wielded_') && o.userData && o.userData.wieldedGuid === ${stone}) copies.push({ name: o.name, ...reachable(o), at: pos(o), holder: o.userData.wielderGuid }); });
  return {
    stone: so ? { wielderId: so.wielderId, outOfWorld: !!so.outOfWorld, lostCell: !!so.lostCell, hasMesh: !!so.mesh,
      mesh: so.mesh ? { ...reachable(so.mesh), visible: so.mesh.visible, at: pos(so.mesh) } : null } : null,
    wielder: w ? { physicsState: w.physicsState, lostCell: !!w.lostCell, mesh: w.mesh ? { ...reachable(w.mesh), visible: w.mesh.visible, at: pos(w.mesh) } : null } : null,
    copies,
  }; })()`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const logA: string[] = [];
  const { a, b, close } = await openTwoClients('wield-orphan');
  a.page.on('console', (m) => { const t = m.text(); if (/Wield|Delete|ParentEvent|PickupEvent|Teleport|lost/i.test(t)) logA.push(t); });
  const results: Record<string, unknown> = { at: new Date().toISOString(), a: a.name, b: b.name };
  // Trace every ServerObjectManager entry point that can move an object in or out of the world.
  await a.page.evaluate(`(() => { const som = window.__ac.serverObjectManager; window.__probeCalls = [];
    for (const m of ['createObject', 'updateInPlace', 'parentEvent', 'pickupEvent', 'applyPositionUpdate', 'deleteObject', 'leaveWorld']) {
      const f = som[m]; if (typeof f !== 'function') continue;
      som[m] = function (...args) { const g = typeof args[0] === 'number' ? args[0] : (args[0] && args[0].guid);
        const o = g !== undefined ? this.getObject(g) : null;
        window.__probeCalls.push({ m, guid: g >>> 0, t: Math.round(performance.now()), before: o ? { outOfWorld: !!o.outOfWorld, wielderId: o.wielderId } : null,
          pos: m === 'createObject' ? !!(args[0] && args[0].position) : undefined, wielder: m === 'createObject' ? args[0].wielderId : undefined });
        return f.apply(this, args); };
    } })()`);
  try {
    await adminCommand(b.page, `@ci ${FOCUSING_STONE}`);
    await b.page.waitForTimeout(3000);
    const stone = await b.page.evaluate(`(() => { const ui = window.__ac.gameUI; const i = (ui.inventoryItems || []).findIndex((it) => it.weenieClassId === ${FOCUSING_STONE});
      if (i < 0) return 0; ui.dragCallbacks.onDoubleClickItem(i); return ui.inventoryItems[i].id; })()`) as number;
    if (!stone) throw new Error('B has no Focusing Stone after @ci');
    results.stone = `0x${stone.toString(16)}`;
    await b.page.waitForTimeout(5000);
    results.wielded = await stoneState(a.page, stone, b.guid);
    await shot(a.page, `${OUT}/1-wielded-a.png`);

    await adminCommand(b.page, `@teleloc ${AWAY_LOC}`);
    await a.page.waitForTimeout(1500);
    results.during = await stoneState(a.page, stone, b.guid);
    await a.page.waitForTimeout(12_000);
    results.after = await stoneState(a.page, stone, b.guid);
    await shot(a.page, `${OUT}/2-after-a.png`);
    await a.page.waitForTimeout(30_000);
    results.after45s = await stoneState(a.page, stone, b.guid);
    await shot(a.page, `${OUT}/3-after45s-a.png`);
    results.logA = logA;
    results.calls = await a.page.evaluate(`window.__probeCalls.filter((c) => c.guid === ${stone})`);
    const after = results.after45s as { stone: { mesh: { inScene: boolean; live: boolean } | null } | null; copies: Array<{ inScene: boolean; live: boolean }> };
    const orphan = (after.stone?.mesh?.inScene && after.stone.mesh.live) || after.copies.some((c) => c.inScene && c.live);
    results.verdict = orphan ? 'FAIL: the stone still draws on A after B left' : 'PASS: nothing draws the stone on A after B left';
    console.log(results.verdict);
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2) + '\n');
    await close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
