/**
 * probe-object-lifetime — live check for BUG.teleport-leaves-stale-objects,
 * BUG.default-script-80-cap and BUG.setlight-hook-emissive-only.
 *
 *  1. Holtburg portal: the portal hums (DefaultScript 0x3300067A — played
 *     with no script cap) and carries its Setup lights.
 *  2. SetLight: acDebug.playScriptOn(0x33000109) on that portal — the EoL
 *     ProjectileCollision script (NoDraw + SetLight off) → LightingOn
 *     cleared, the object's lights destroyed (CPhysicsObj::set_lights).
 *  3. Teleport into a sealed dungeon: every Holtburg object leaves the world
 *     at once (hidden, frozen: no hum is heard) and is deleted 25 s later
 *     (CObjectMaint NONVISIBLE_OBJECT_DESTRUCTION_TIME).
 *  4. Ten more teleports (dungeon ↔ Holtburg, 30 s apart): object / script /
 *     light-carrier counts and renderer.info.memory after each — nothing may
 *     accumulate.
 *
 * Usage (own account — never testacjs / testacjs2):
 *   AC_ACCOUNT=fxprobe1 AC_PASSWORD=fxprobe1 AC_BASE=http://localhost:3171/ \
 *     npx tsx tools/probe-object-lifetime.ts [--gpu] [--out verification/effects/object-lifetime] [--hops 10]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand, sessionArgs } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = arg('out') ?? 'verification/effects/object-lifetime';
const HOPS = Number(arg('hops') ?? 10);
const TOWN = arg('town') ?? '@teleloc 0xA9B40003 [19 55.6 78.2] 1 0 0 0';
const DUNGEON = arg('dungeon') ?? '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';
const HUM = '0xa00038e';

const HOOK = `(() => {
  const ac = window.__ac;
  const rec = window.__olt = { t0: performance.now(), pos: [] };
  const sp = ac.soundPlayer, pp = sp.playPositionalSound.bind(sp);
  sp.playPositionalSound = (wave, pos, listener, category, volume) => {
    rec.pos.push({ t: Math.round(performance.now() - rec.t0), wave: '0x' + (wave >>> 0).toString(16),
      dist: +Math.hypot(pos.x - listener.x, pos.y - listener.y, pos.z - listener.z).toFixed(1) });
    return pp(wave, pos, listener, category, volume);
  };
  return 'hooked';
})()`;

const STATS = `(() => {
  const ac = window.__ac, som = ac.serverObjectManager, scene = ac.sceneManager.scene, r = ac.sceneManager.renderer;
  const all = [...som.getAllObjects().values()];
  let pointVisible = 0; scene.traverseVisible((o) => { if (o.isPointLight) pointVisible++; });
  return {
    t: Math.round(performance.now() - window.__olt.t0),
    objects: all.length, withMesh: all.filter(o => o.mesh).length, lost: som.lostObjectCount,
    portals: all.filter(o => o.setupId === 0x020001b3).length,
    scripts: window.acDebug.activeScripts(),
    carriers: scene.children.filter(c => c.name === 'object-light-carrier').length,
    sceneChildren: scene.children.length,
    geometries: r.info.memory.geometries, textures: r.info.memory.textures,
    programs: r.info.programs ? r.info.programs.length : -1, pointVisible,
  };
})()`;

const portalInfo = (guid: number): string => `(() => {
  const ac = window.__ac, o = ac.serverObjectManager.getObject(${guid});
  if (!o) return null;
  const carrier = ac.sceneManager.scene.children.find(c => c.name === 'object-light-carrier' && c.owner === o.mesh);
  return { guid: '0x' + o.guid.toString(16), name: o.name, phys: '0x' + (o.physicsState >>> 0).toString(16),
    lightingOn: (o.physicsState & 0x800) !== 0, lostCell: !!o.lostCell, meshVisible: !!(o.mesh && o.mesh.visible),
    lights: carrier ? carrier.children.length : 0, lightsLit: carrier ? carrier.children.filter(l => l.visible).length : 0 };
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-object-lifetime', ...sessionArgs() } as never);
  const page = s.page;
  const report: Record<string, unknown> = {};
  await page.waitForTimeout(3000);
  console.log(await page.evaluate(HOOK));
  await page.mouse.click(4, 300);
  const stats = async (label: string) => { const v = await page.evaluate(STATS) as Record<string, number>; console.log(label.padEnd(22), JSON.stringify(v)); return { label, ...v }; };

  // 1. Holtburg portal.
  await adminCommand(page, TOWN);
  await page.waitForTimeout(20_000);
  const town0 = await stats('town arrival');
  await page.evaluate('window.__olt.pos = []');
  await page.waitForTimeout(8000);
  const humsTown = (await page.evaluate('window.__olt.pos') as Array<{ wave: string }>).filter((x) => x.wave === HUM).length;
  const portals = await page.evaluate(`(() => { const ac = window.__ac, me = ac.playerModel.position;
    return [...ac.serverObjectManager.getAllObjects().values()].filter(o => o.setupId === 0x020001b3 && o.mesh)
      .map(o => ({ guid: o.guid, d: Math.hypot(o.worldX - me.x, o.worldZ - me.z) })).sort((a, b) => a.d - b.d); })()`) as Array<{ guid: number; d: number }>;
  console.log(`town: ${humsTown} hums in 8 s, ${portals.length} portals`);
  await page.screenshot({ path: `${OUT}/town-portal.jpg`, type: 'jpeg', quality: 80 });
  report.town = { stats: town0, humsIn8s: humsTown, portals: portals.length };

  // 2. SetLight (0x33000109) on the nearest portal.
  const target = portals[0]?.guid;
  if (target !== undefined) {
    const before = await page.evaluate(portalInfo(target));
    const ret = await page.evaluate(`window.acDebug.playScriptOn(0x33000109, ${target})`);
    await page.waitForTimeout(1500);
    const after = await page.evaluate(portalInfo(target));
    console.log('setlight before:', JSON.stringify(before));
    console.log('setlight after: ', JSON.stringify(after), ret);
    await page.screenshot({ path: `${OUT}/town-portal-lights-off.jpg`, type: 'jpeg', quality: 80 });
    report.setLight = { before, after, playScriptOn: ret };
  }

  // 3. Into the dungeon.
  const townGuids = await page.evaluate('[...window.__ac.serverObjectManager.getAllObjects().keys()]') as number[];
  await adminCommand(page, DUNGEON);
  await page.waitForTimeout(8000);
  await page.evaluate('window.__olt.pos = []');
  const dungeonIn = await stats('dungeon +8 s');
  const townLeft = await page.evaluate(`(() => { const som = window.__ac.serverObjectManager; const g = ${JSON.stringify(townGuids)};
    const known = g.map(x => som.getObject(x)).filter(Boolean); return { known: known.length, lost: known.filter(o => o.lostCell).length, visible: known.filter(o => o.mesh && o.mesh.visible).length }; })()`);
  console.log('town objects in dungeon +8 s:', JSON.stringify(townLeft));
  await page.waitForTimeout(12_000);
  const humsDungeon = (await page.evaluate('window.__olt.pos') as Array<{ wave: string }>).filter((x) => x.wave === HUM).length;
  const dungeonMid = await stats('dungeon +20 s');
  await page.waitForTimeout(10_000);
  const dungeonLate = await stats('dungeon +30 s');
  const townGone = await page.evaluate(`(() => { const som = window.__ac.serverObjectManager; return ${JSON.stringify(townGuids)}.filter(x => som.getObject(x)).length; })()`);
  console.log(`dungeon: ${humsDungeon} Holtburg hums heard in 12 s; ${townGone} Holtburg objects still known at +30 s`);
  await page.screenshot({ path: `${OUT}/dungeon.jpg`, type: 'jpeg', quality: 80 });
  report.dungeon = { atPlus8: { stats: dungeonIn, townObjects: townLeft }, humsHeard12s: humsDungeon, atPlus20: dungeonMid, atPlus30: dungeonLate, townObjectsKnownAt30: townGone };

  // 4. Hops.
  const hops: unknown[] = [];
  for (let i = 0; i < HOPS; i++) {
    const to = i % 2 === 0 ? TOWN : DUNGEON;
    await adminCommand(page, to);
    await page.waitForTimeout(30_000);
    hops.push(await stats(`hop ${i + 1} ${i % 2 === 0 ? 'town' : 'dungeon'}`));
  }
  report.hops = hops;
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
