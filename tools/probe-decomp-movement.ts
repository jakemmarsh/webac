/**
 * probe-decomp-movement — live checks for the 2026-09-30 remote-movement /
 * MoveTo port (DECOMP W3/W4/W5/A6/P2/P3). Client A = testacjs2, observer
 * B = testacjs3. One live run at a time.
 *   P3: A Uses a distant Holtburg door; the Use is sent at once and the
 *       server MoveTo walks A until the door toggles.
 *   W3: A Uses an NPC from behind; the NPC turns to face A.
 *   A6: a sewer rat (wcid 7106, melee) aggroes on A and closes the distance.
 *   W4/W5: B samples A's position while A runs: steady motion, no stalls.
 * Usage: npx tsx tools/probe-decomp-movement.ts [--swiftshader]   (real GPU by default: smoothness needs real frame rates)
 */
import { enterWorld, adminCommand, gameUrl } from './lib/game-session.ts';
const urlFor = (account: string) => gameUrl({ cb: 'movement', env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account } });
const GPU = !process.argv.includes('--swiftshader');
/** Teleport, then wait for our LoginComplete (ACE ignores actions until it arrives). */
async function teleportAndSettle(page: import('playwright').Page, cmd: string): Promise<void> {
  let done = false;
  const onLog = (m: import('playwright').ConsoleMessage) => { if (/Sent LoginComplete/.test(m.text())) done = true; };
  page.on('console', onLog);
  await adminCommand(page, cmd);
  for (let i = 0; i < 90 && !done; i++) await page.waitForTimeout(500);
  page.off('console', onLog);
  await page.waitForTimeout(3000);
}
const A = await enterWorld({ url: urlFor('testacjs2'), gpu: GPU });
const a = A.page;
await teleportAndSettle(a, '@telepoi Holtburg');
const me = () => a.evaluate('JSON.stringify(window.acDebug.collisionState())').then((s) => JSON.parse(s as string));
const objs = () => a.evaluate("JSON.stringify(window.acDebug.listServerObjects().map(o => { const so = window.__ac.serverObjectManager.getObject(o.guid); return { guid: o.guid, name: o.name, x: so?.worldX, z: so?.worldZ, yaw: so?.mesh ? so.mesh.rotation.y : null }; }))").then((s) => JSON.parse(s as string));
const dist = (p: any, o: any) => Math.hypot(p.x - o.x, p.z - o.z);
const out: Record<string, unknown> = {};

// P3 — distant door
{
  const p0 = await me(); const doors = (await objs()).filter((o: any) => o.name === 'Door').sort((x: any, y: any) => dist(p0, x) - dist(p0, y));
  const door = doors.find((d: any) => dist(p0, d) > 6) ?? doors[0];
  const d0 = dist(p0, door);
  await a.evaluate(`window.acDebug.useObject(${door.guid})`);
  let best = d0; for (let i = 0; i < 16; i++) { await a.waitForTimeout(500); best = Math.min(best, dist(await me(), door)); }
  out.P3 = { doorStartDist: +d0.toFixed(1), closestDistAfter8s: +best.toFixed(1) };
}
// W3 — NPC turns to face
{
  const p = await me(); const npcs = (await objs()).filter((o: any) => /Shopkeeper|Barkeeper|the Grocer|Scribe|Contract Broker/.test(o.name)).sort((x: any, y: any) => dist(p, x) - dist(p, y));
  const npc = npcs[0];
  if (npc) {
    const yaw0 = npc.yaw; await a.evaluate(`window.acDebug.useObject(${npc.guid})`); await a.waitForTimeout(9000);
    const n1 = (await objs()).find((o: any) => o.guid === npc.guid); const pp = await me();
    out.W3 = { npc: npc.name, yawBefore: yaw0 && +yaw0.toFixed(2), yawAfter: n1?.yaw && +n1.yaw.toFixed(2), distNow: +dist(pp, n1).toFixed(1) };
  }
}
// A6 — monster chase
{
  await adminCommand(a, '@create 7106'); await a.waitForTimeout(3000);
  const sk = (await objs()).filter((o: any) => /Rat/.test(o.name)).pop();
  if (sk) {
    const samples: string[] = [];
    for (let i = 0; i < 12; i++) {
      await a.waitForTimeout(500);
      const s = await a.evaluate(`(() => { const som = window.__ac.serverObjectManager; const o = som.getObject(${sk.guid}); const an = som.getAnimated(${sk.guid}); const p = window.acDebug.collisionState(); return o ? Math.hypot(o.worldX - p.x, o.worldZ - p.z).toFixed(1) + ':' + (an?.motionManager?.currentSubstate?.toString(16) ?? an?.motionManager?.currentMotion?.toString(16) ?? '?') : 'gone'; })()`);
      samples.push(s as string);
    }
    out.A6idle = samples.join(' ');
    // provoke: melee-attack it from range — P2 runs us at it, A6 brings it back at us
    await a.evaluate("window.acDebug.combatMode('melee')"); await a.waitForTimeout(2000);
    await a.evaluate(`window.acDebug.selectServerObject(${sk.guid}); window.acDebug.attack(${sk.guid})`);
    const after: string[] = [];
    for (let i = 0; i < 12; i++) {
      await a.waitForTimeout(500);
      after.push(await a.evaluate(`(() => { const som = window.__ac.serverObjectManager; const o = som.getObject(${sk.guid}); const p = window.acDebug.collisionState(); return o ? Math.hypot(o.worldX - p.x, o.worldZ - p.z).toFixed(1) + (o.moveTo ? '+mt' : '') : 'gone'; })()`) as string);
    }
    out.A6provoked = after.join(' ');
    await a.evaluate("window.acDebug.combatMode('peace')");
    await a.evaluate(`window.acDebug.selectServerObject(${sk.guid})`); await adminCommand(a, '@smite');
  }
}
// W4/W5 — B watches A run
{
  const B = await enterWorld({ url: urlFor('testacjs3'), gpu: GPU }); const b = B.page;
  await teleportAndSettle(b, '@teleto TestPartner');
  const aGuid = await b.evaluate(`(window.acDebug.listServerObjects().find(o => /TestPartner/.test(o.name)) || {}).guid || 0`);
  await a.mouse.click(780, 300); await a.keyboard.down('KeyW');
  const pts: number[][] = [];
  for (let i = 0; i < 20; i++) { await b.waitForTimeout(150); pts.push(JSON.parse(await b.evaluate(`JSON.stringify((o => o ? [o.worldX, o.worldZ] : [0,0])(window.__ac.serverObjectManager.getObject(${aGuid})))`) as string)); }
  await a.keyboard.up('KeyW');
  const steps = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  out.W4W5 = { stepsM: steps.map((s) => +s.toFixed(2)), stalls: steps.filter((s) => s < 0.05).length };
  await B.browser.close();
}
console.log(JSON.stringify(out, null, 1));
await A.browser.close();
