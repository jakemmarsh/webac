/**
 * probe-creature-shape-and-anim — object-lifecycle sweep part 3, live:
 *  anim   BUG.setup-default-animation-never-played — a Frost Bolt I (28)
 *         in flight loops its Setup DefaultAnimation (CPartArray::InitDefaults):
 *         its frame advances while it flies.
 *  shape  BUG.missile-creature-shape — it stops on the drudge's Setup
 *         spheres x its ObjScale (FindObjCollisions → CSphere), not on the
 *         Setup's bounding cylinder: the bolt's centre ends r_sphere x scale +
 *         r_bolt from the nearest sphere centre.
 *  dying  BUG.dying-creature-loses-collision — @smite the drudge: while it
 *         plays Dead it is still one of our blockers.
 * Writes verification/creature-shape-and-anim/results.json; exits 1 on a failure.
 *
 * Usage: AC_ACCOUNT=fxprobe1 AC_BASE=http://localhost:3011/ npx tsx tools/probe-creature-shape-and-anim.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { adminCommand, enterWorld, shot } from './lib/game-session.ts';
import { MEET_LOC } from './lib/two-client.ts';

const OUT = 'verification/creature-shape-and-anim';
/** Frost Bolt I: the drudge survives it, so its record is still there to measure against. */
const FROST_BOLT = 28;
const DRUDGE = 19257;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ cb: 'shape-anim', createCharacter: 'Fxprobe' } as never);
  const results: Record<string, unknown> = { at: new Date().toISOString() };
  const fails: string[] = [];
  try {
    await page.waitForTimeout(3000);
    await adminCommand(page, `@teleloc ${MEET_LOC}`);
    await page.waitForTimeout(7000);
    await adminCommand(page, '@god');
    await page.waitForTimeout(1000);
    await adminCommand(page, `@addspell ${FROST_BOLT}`);
    await page.waitForTimeout(1000);
    const castLog: string[] = [];
    page.on('console', (m) => { const t = m.text(); if (/cast|fizzl|component|spell|mana|skill/i.test(t)) castLog.push(t.slice(0, 200)); });
    results.castLog = castLog;
    await adminCommand(page, `@create ${DRUDGE}`);
    await page.waitForTimeout(4000);
    const drudge = await page.evaluate(`(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (o.weenieClassId === ${DRUDGE} && !window.__ac.serverObjectManager.isDying(o.guid)) return o.guid; return 0; })()`) as number;
    if (!drudge) throw new Error('no drudge');
    // Record every missile's flight: DefaultAnimation frames, and where it stops.
    await page.evaluate(`(() => { const som = window.__ac.serverObjectManager; window.__flight = {};
      const tick = () => { for (const o of som.objects.values()) { if (!som.isProjectile(o.guid)) continue;
        const f = window.__flight[o.guid] ||= { frames: [], stop: null, name: o.name };
        f.frames.push(som.defaultAnimationFrame(o.guid));
        const b = som.getMissileBody(o.guid); if (b && !f.stop && b.vel.x === 0 && b.vel.y === 0 && b.vel.z === 0) f.stop = [o.worldX, o.worldY, o.worldZ]; }
        requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
    // The drudge as the bolt meets it (it stands still; read before the cast).
    const drudgeInfo = await page.evaluate(`(() => { const d = window.__ac.serverObjectManager.getObject(${drudge});
      const ds = window.__ac.setupModelRenderer.loadSetupModel(d.setupId);
      return { at: [d.worldX, d.worldY, d.worldZ], scale: d.mesh.scale.x,
        spheres: ds ? ds.spheres.map((s) => ({ z: s.origin.z, r: s.radius })) : null, cyl: ds ? ds.cylSpheres.length : null, radius: ds ? ds.radius : null }; })()`) as
      { at: number[]; scale: number; spheres: Array<{ z: number; r: number }> | null; cyl: number | null; radius: number | null };
    await page.evaluate(`window.acDebug.select(${drudge})`);
    await page.evaluate(`window.__ac.castSpell(${FROST_BOLT}, ${drudge})`);
    await page.waitForTimeout(6000);
    await shot(page, `${OUT}/1-after-bolt.png`);
    const flight = { flights: await page.evaluate('window.__flight') as Record<string, { frames: Array<number | null>; stop: number[] | null; name: string }>, drudge: drudgeInfo };
    const bolts = Object.values(flight.flights);
    const bolt = bolts[0];
    results.anim = { frames: bolt?.frames.filter((f) => f !== null).slice(0, 12), n: bolt?.frames.length };
    const animFrames = (bolt?.frames ?? []).filter((f): f is number => f !== null);
    const animOk = animFrames.length > 3 && new Set(animFrames.map((f) => Math.floor(f))).size > 2;
    if (!animOk) fails.push('anim');
    console.log(`${animOk ? 'PASS' : 'FAIL'} anim: ${JSON.stringify(results.anim)}`);

    const d = flight.drudge;
    let shapeOk = false;
    if (bolt?.stop && d.spheres) {
      const gaps = d.spheres.map((s) => Math.hypot(bolt.stop![0] - d.at[0], bolt.stop![1] - (d.at[1] + s.z * d.scale), bolt.stop![2] - d.at[2]));
      const gap = Math.min(...gaps);
      const horiz = Math.hypot(bolt.stop[0] - d.at[0], bolt.stop[2] - d.at[2]);
      results.shape = { stop: bolt.stop, drudge: d, gapToNearestSphere: +gap.toFixed(3), sphereR: d.spheres[0].r * d.scale, horizToAxis: +horiz.toFixed(3), boundingR: d.radius };
      // the bolt's centre sits r_sphere*scale + r_bolt (≤ 0.3) from a sphere centre
      shapeOk = gap > d.spheres[0].r * d.scale && gap < d.spheres[0].r * d.scale + 0.35;
    } else results.shape = { stop: bolt?.stop ?? null, drudge: d };
    if (!shapeOk) fails.push('shape');
    console.log(`${shapeOk ? 'PASS' : 'FAIL'} shape: ${JSON.stringify(results.shape)}`);

    // dying — a fresh drudge, smitten; sampled while it plays Dead.
    await adminCommand(page, '@smite all');
    await page.waitForTimeout(6000);
    await adminCommand(page, `@create ${DRUDGE}`);
    await page.waitForTimeout(4000);
    const drudge2 = await page.evaluate(`(() => { for (const o of window.__ac.serverObjectManager.objects.values()) if (o.weenieClassId === ${DRUDGE} && o.guid !== ${drudge} && !window.__ac.serverObjectManager.isDying(o.guid)) return o.guid; return 0; })()`) as number;
    await adminCommand(page, '@smite all');
    let dying: unknown = null;
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(150);
      dying = await page.evaluate(`(() => { const som = window.__ac.serverObjectManager; const o = som.getObject(${drudge2}); if (!o) return { gone: true };
        return { isDying: som.isDying(${drudge2}), blockRadius: o.blockRadius, blocks: som.getBlockersNear(o.worldX, o.worldZ, 3).some((b) => b.guid === ${drudge2}) }; })()`);
      if ((dying as { isDying?: boolean }).isDying) break;
    }
    results.dying = dying;
    const dy = dying as { isDying?: boolean; blocks?: boolean };
    const dyingOk = !!dy?.isDying && !!dy.blocks;
    if (!dyingOk) fails.push('dying');
    console.log(`${dyingOk ? 'PASS' : 'FAIL'} dying: ${JSON.stringify(dying)}`);
    await shot(page, `${OUT}/2-dying.png`);
  } finally {
    results.fails = fails;
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2) + '\n');
    await browser.close();
  }
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
