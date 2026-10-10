/**
 * probe-creature-collision — "invisible walls near my corpse / that mob".
 *
 * Spawns an aggressive Drudge Skulker (wcid 7) next to a god-mode character,
 * records how its drawn position tracks the server's (MoveTo events vs
 * UpdatePosition), then smites it and walks the character straight through
 * the corpse, recording every creature collider near the player (radius,
 * visibility) and where the walk gets stopped.
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-creature-collision.ts
 */
import { enterWorld, adminCommand, shot } from './lib/game-session.js';
const OUT = 'verification/creature-collision';

const COLLIDERS = `(() => { const ac = window.__ac, cs = window.acDebug.collisionState();
  const blockers = ac.serverObjectManager.getBlockersNear(cs.x, cs.z, 15).map((b) => ({ x: +b.worldX.toFixed(1), z: +b.worldZ.toFixed(1), r: +b.collisionRadius.toFixed(3) }));
  return { blockers, creatures: [...ac.serverObjectManager.objects.values()].filter((o) => (o.itemType & 0x10) !== 0 && o.collisionRadius > 0)
    .map((o) => ({ name: o.name, guid: o.guid.toString(16), r: +o.collisionRadius.toFixed(2), vis: !!(o.mesh && o.mesh.visible),
      state: (o.physicsState >>> 0).toString(16), d: +Math.hypot(o.worldX - cs.x, o.worldZ - cs.z).toFixed(2) }))
    .filter((o) => o.d < 15) }; })()`;

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'creature-collision' } as never);
  await s.page.waitForTimeout(4000);
  await adminCommand(s.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await s.page.waitForTimeout(8000);
  // CC_NOGOD=1: take the drudge's hits (their Splatter* PlayScript lands on us).
  if (!process.env.CC_NOGOD) await adminCommand(s.page, '@god');
  await s.page.waitForTimeout(1500);
  const logs: string[] = [];
  s.page.on('console', (m) => { const x = m.text(); if (/PScript|createWeaponImpact|TargetedMelee|AttackDone|procedural/.test(x)) logs.push(x.slice(0, 120)); });
  await s.page.evaluate(`window.acDebug.unwield('Held')`);
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`window.acDebug.equip('Rusted Dirk')`);
  await s.page.waitForTimeout(2500);
  console.log('colliders before', JSON.stringify(await s.page.evaluate(COLLIDERS)));
  await s.page.evaluate(`(() => { const som = window.__ac.serverObjectManager; const rec = window.__cc = { ev: [], tl: [], t0: performance.now() };
    const t = () => Math.round(performance.now() - rec.t0);
    const orig = som.applyParsedMotion.bind(som);
    som.applyParsedMotion = (g, a, p) => { const o = som.objects.get(g); if (o && /drudge/i.test(o.name || '')) rec.ev.push({ t: t(), type: p.movementType, fwd: p.forwardCommand.toString(16), fs: +(p.forwardSpeed||0).toFixed(2), mt: p.moveTo ? { run: p.moveTo.runRate, wrt: p.moveTo.walkRunThreshold, d: p.moveTo.distanceToObject } : null }); return orig(g, a, p); };
    setInterval(() => { const cs = window.acDebug.collisionState(); const d = [...som.objects.values()].find((o) => /drudge/i.test(o.name || '') && o.collisionRadius > 0);
      if (d) rec.tl.push({ t: t(), drawn: [+d.worldX.toFixed(1), +d.worldZ.toFixed(1)], target: [+(d.targetWorldX ?? 0).toFixed(1), +(d.targetWorldZ ?? 0).toFixed(1)], me: [+cs.x.toFixed(1), +cs.z.toFixed(1)] }); }, 250);
  })()`);
  await adminCommand(s.page, '@create 7');
  await s.page.waitForTimeout(8000);
  const foe = await s.page.evaluate(`(() => { const o = [...window.__ac.serverObjectManager.objects.values()].find((o) => /drudge/i.test(o.name || '') && o.collisionRadius > 0); return o ? o.guid : 0; })()`) as number;
  // The spawn's Create PlayScript (0x33000232: Transparent 1 → 0 over 1 s)
  // must leave it SOLID — it used to fade it out to invisible.
  console.log('spawned drudge opacity (min over its materials):', await s.page.evaluate(`(() => { const o = window.__ac.serverObjectManager.getObject(${foe}); let m = 1;
    o && o.mesh && o.mesh.traverse((c) => { if (c.isMesh) for (const mat of [].concat(c.material)) m = Math.min(m, mat.opacity); }); return m; })()`));
  await shot(s.page, `${OUT}/0-spawned.png`);
  await s.page.evaluate(`window.acDebug.select(${foe})`);
  await s.page.evaluate(`window.acDebug.combatMode('melee')`);
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`window.acDebug.attack(${foe})`);
  await s.page.waitForTimeout(1200);
  await shot(s.page, `${OUT}/0-hit.png`);
  await s.page.waitForTimeout(4000);
  await s.page.evaluate(`window.acDebug.combatMode('peace')`);
  await s.page.waitForTimeout(1500);
  await shot(s.page, `${OUT}/1-aggro.png`);
  const cc = JSON.parse(await s.page.evaluate('JSON.stringify(window.__cc)') as string);
  console.log('events', JSON.stringify(cc.ev));
  console.log('timeline', cc.tl.map((r: { t: number; drawn: number[]; target: number[]; me: number[] }) => `${r.t}:${r.drawn}→${r.target}|me ${r.me}`).join(' '));
  console.log('combat logs', logs.join(' || '));
  console.log('colliders fighting', JSON.stringify(await s.page.evaluate(COLLIDERS)));
  const drudge = await s.page.evaluate(`(() => { const o = [...window.__ac.serverObjectManager.objects.values()].find((o) => /drudge/i.test(o.name || '') && o.collisionRadius > 0); return o ? o.guid : 0; })()`) as number;
  await s.page.evaluate(`window.acDebug.select(${drudge})`);
  await adminCommand(s.page, '@smite');
  await s.page.waitForTimeout(8000);
  const objs = await s.page.evaluate(`(() => { const cs = window.acDebug.collisionState(); return [...window.__ac.serverObjectManager.objects.values()]
    .map((o) => ({ name: o.name, guid: o.guid.toString(16), type: o.itemType, r: o.collisionRadius, x: o.worldX, z: o.worldZ, vis: !!(o.mesh && o.mesh.visible), d: Math.hypot(o.worldX - cs.x, o.worldZ - cs.z) }))
    .filter((o) => o.d < 10); })()`) as Array<{ name: string; x: number; z: number; d: number; r: number }>;
  console.log('objects after smite', JSON.stringify(objs));
  const corpse = objs.find((o) => /corpse/i.test(o.name));
  const me = await s.page.evaluate('window.acDebug.collisionState()') as { x: number; z: number };
  if (corpse) {
    // Face the corpse and run through it (and 4 m past).
    const dx = corpse.x - me.x, dz = corpse.z - me.z, len = Math.hypot(dx, dz);
    await s.page.evaluate(`window.acDebug.setPlayerYaw(${Math.atan2(-dx / len, -dz / len)})`);
    await s.page.waitForTimeout(500);
    await s.page.mouse.click(780, 300);
    const path: string[] = [];
    await s.page.keyboard.down('w');
    for (let i = 0; i < 16; i++) {
      await s.page.waitForTimeout(250);
      const p = await s.page.evaluate('window.acDebug.collisionState()') as { x: number; z: number };
      path.push(`${p.x.toFixed(2)},${p.z.toFixed(2)} (to corpse ${Math.hypot(corpse.x - p.x, corpse.z - p.z).toFixed(2)})`);
    }
    await s.page.keyboard.up('w');
    console.log('walk through corpse', path.join(' | '));
    console.log('colliders at end', JSON.stringify(await s.page.evaluate(COLLIDERS)));
    await shot(s.page, `${OUT}/2-after-walk.png`);
  } else console.log('no corpse found');
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
