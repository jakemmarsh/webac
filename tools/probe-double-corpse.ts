/**
 * probe-double-corpse — live check for BUG.double-corpse: killing a creature
 * must leave ONE body. ACE runs CreateCorpse + Destroy together once the
 * death animation ends (Creature_Death.cs:131-135); the client used to hold
 * the deleted creature for another 4.5 s beside the new corpse object.
 * Spawns a drudgeskulker-noaggro (wcid 19257), @smites it, samples every
 * 100 ms how many meshed objects named after it are in the scene.
 * Usage: ACJS_ACCOUNT=testacjs2 npx tsx tools/probe-double-corpse.ts [shot.png]
 */
import { chromium } from 'playwright';
const ACCOUNT = process.env.ACJS_ACCOUNT ?? 'testacjs';
const URL = process.env.AC_URL ?? `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=${ACCOUNT}&password=${ACCOUNT}&cb=corpse`;
async function main(): Promise<void> {
  const shot = process.argv[2];
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) { if (await page.evaluate(`!!(window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState().x > 0)`).catch(() => false)) break; await page.waitForTimeout(1000); }
  await page.waitForTimeout(6000);
  await page.evaluate(`window.acDebug.sendChat('@telepoi Holtburg')`);
  await page.waitForTimeout(20_000);
  await page.evaluate(`window.acDebug.sendChat('@create 19257')`);
  await page.waitForTimeout(5000);
  const skulkers = await page.evaluate(`window.acDebug.listServerObjects().filter(o => /skulker/i.test(o.name) && !/corpse/i.test(o.name)).map(o => o.guid)`) as number[];
  if (skulkers.length < 1) { console.log('FAIL: no skulker spawned'); await browser.close(); process.exit(1); }
  const victim = skulkers[skulkers.length - 1];
  const bodies = `(() => { const out = []; for (const o of window.acDebug.listServerObjects()) { if (!/skulker/i.test(o.name)) continue; const so = window.__ac.serverObjectManager.getObject(o.guid); if (so && so.mesh && so.mesh.parent) out.push(o.name + '#' + (o.guid >>> 0).toString(16)); } return out; })()`;
  const before = await page.evaluate(bodies) as string[];
  await page.evaluate(`window.acDebug.selectServerObject(${victim})`);
  await page.waitForTimeout(800);
  await page.evaluate(`window.acDebug.sendChat('@smite')`);
  let maxBodies = 0; let sawCorpse = false; let overlapMs = 0; let last = '';
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(100);
    const now = await page.evaluate(bodies) as string[];
    const newBodies = now.filter((n) => !before.includes(n) || n.endsWith((victim >>> 0).toString(16)));
    maxBodies = Math.max(maxBodies, newBodies.length);
    if (newBodies.some((n) => /corpse/i.test(n))) sawCorpse = true;
    if (newBodies.length > 1) overlapMs += 100;
    const line = newBodies.join(', ');
    if (line !== last) { console.log(`t=${i * 100}ms: [${line}]`); last = line; }
  }
  if (shot) await page.screenshot({ path: shot });
  console.log(`corpse appeared: ${sawCorpse}; max simultaneous bodies: ${maxBodies}; overlap: ${overlapMs} ms`);
  console.log(sawCorpse && maxBodies === 1 ? 'PASS' : 'FAIL');
  await browser.close();
  process.exit(sawCorpse && maxBodies === 1 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
