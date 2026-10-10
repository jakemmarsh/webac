/**
 * probe-death-fade-shared-material — live check for
 * REND.shared-cached-material-disposed-faded: two identical creatures share
 * MaterialFactory-cached materials; killing one (death fade) must not fade or
 * dispose the other's materials.
 * Spawns two drudgeskulker-noaggro (wcid 19257), selects one, @smite.
 * Usage: npx tsx tools/probe-death-fade-shared-material.ts  (vite :3000 + bridge :9090 + ACE, admin account)
 */
import { chromium } from 'playwright';
const URL = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=fade';
async function main(): Promise<void> {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) { if (await page.evaluate(`!!(window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState().x > 0)`).catch(() => false)) break; await page.waitForTimeout(1000); }
  await page.waitForTimeout(6000);
  await page.evaluate(`window.acDebug.sendChat('@telepoi Holtburg')`);
  await page.waitForTimeout(20_000);
  await page.evaluate(`window.acDebug.sendChat('@create 19257')`);
  await page.waitForTimeout(1500);
  await page.evaluate(`window.acDebug.sendChat('@create 19257')`);
  await page.waitForTimeout(5000);
  const skulkers = await page.evaluate(`window.acDebug.listServerObjects().filter(o => /skulker/i.test(o.name)).map(o => o.guid)`) as number[];
  console.log('skulkers:', skulkers.map((g) => '0x' + (g >>> 0).toString(16)).join(' '));
  if (skulkers.length < 2) { console.log('FAIL: need two skulkers'); await browser.close(); process.exit(1); }
  const [victim, other] = skulkers.slice(-2);
  const mats = (guid: number) => page.evaluate(`(() => { const o = window.__ac.serverObjectManager.getObject(${guid}); if (!o || !o.mesh) return null;
    const out = []; o.mesh.traverse((c) => { if (c.isMesh) for (const m of [].concat(c.material)) out.push({ uuid: m.uuid.slice(0, 8), opacity: m.opacity, transparent: m.transparent, disposed: !!m.userData.__disposed }); }); return out; })()`) as Promise<Array<{ uuid: string; opacity: number; transparent: boolean }> | null>;
  const before = await mats(other);
  const victimMats = await mats(victim);
  const shared = (before ?? []).filter((m) => (victimMats ?? []).some((v) => v.uuid === m.uuid)).length;
  console.log(`other's materials: ${before?.length}, shared with the victim: ${shared}`);
  await page.evaluate(`window.acDebug.selectServerObject(${victim})`);
  await page.waitForTimeout(1000);
  await page.evaluate(`window.acDebug.sendChat('@smite')`);
  let minOpacity = 1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const m = await mats(other);
    for (const x of m ?? []) minOpacity = Math.min(minOpacity, x.opacity);
  }
  const victimGone = await page.evaluate(`!window.__ac.serverObjectManager.getObject(${victim}) || !window.__ac.serverObjectManager.getObject(${victim}).mesh`);
  console.log(`victim faded/removed: ${victimGone}; other's minimum material opacity over 10 s: ${minOpacity}`);
  console.log(minOpacity === 1 && shared > 0 ? 'PASS' : shared === 0 ? 'INCONCLUSIVE (no shared materials)' : 'FAIL');
  await page.evaluate(`window.acDebug.selectServerObject(${other})`);
  await page.evaluate(`window.acDebug.sendChat('@smite')`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
