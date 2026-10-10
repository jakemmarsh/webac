/**
 * probe-decomp-state — live state checks for 2026-09-30 DECOMP fixes that are
 * observable from client state on one character (testacjs2, real GPU):
 *   A5 locomotion links on start/stop; A4 landing returns to Ready with no
 *   Interpolating clip; P6 standing long jump (no movement during the charge,
 *   forward leap on release); S4 Always Daylight keeps night fog with noon
 *   light; W6 server objects sit at the server Z.
 * Usage: npx tsx tools/probe-decomp-state.ts
 */
import { enterWorld, adminCommand } from './lib/game-session.ts';
const { browser, page: a } = await enterWorld({ gpu: true });
let done = false; a.on('console', (m) => { if (/Sent LoginComplete/.test(m.text())) done = true; });
await adminCommand(a, '@telepoi Holtburg'); for (let i = 0; i < 90 && !done; i++) await a.waitForTimeout(500); await a.waitForTimeout(3000);
await a.mouse.click(780, 250);
const out: Record<string, unknown> = {};
const ev = (js: string) => a.evaluate(js);
const pos = async () => JSON.parse(await ev('JSON.stringify(window.acDebug.collisionState())') as string);

// A5
{
  const seen: boolean[] = [];
  await a.keyboard.down('KeyW');
  for (let i = 0; i < 12; i++) { seen.push(await ev('window.__ac.animController.mm.isPlayingSubstateLink') as boolean); await a.waitForTimeout(25); }
  await a.waitForTimeout(800); await a.keyboard.up('KeyW');
  const stop: boolean[] = [];
  for (let i = 0; i < 12; i++) { stop.push(await ev('window.__ac.animController.mm.isPlayingSubstateLink') as boolean); await a.waitForTimeout(25); }
  out.A5 = { startLinkSeen: seen.includes(true), stopLinkSeen: stop.includes(true) };
}
await a.waitForTimeout(1000);
// A4
{
  await a.keyboard.down('Space'); await a.waitForTimeout(300); await a.keyboard.up('Space');
  await a.waitForTimeout(2500);
  out.A4 = { primaryAfterLanding: ((await ev('window.__ac.animController.currentPrimaryMotion')) as number >>> 0).toString(16), airborne: await ev('window.__ac.animController._airborne') };
}
// P6
{
  const p0 = await pos();
  await a.keyboard.down('Space'); await a.waitForTimeout(250); await a.keyboard.down('KeyW');
  const slj = await ev('window.__ac.animController.standingLongJump');
  await a.waitForTimeout(700); const p1 = await pos();
  await a.keyboard.up('Space'); await a.waitForTimeout(1500); await a.keyboard.up('KeyW');
  const p2 = await pos();
  out.P6 = { standingLongJumpFlag: slj, movedDuringCharge: +Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2), leapDistance: +Math.hypot(p2.x - p1.x, p2.z - p1.z).toFixed(2) };
}
// S4
{
  await ev('window.acDebug.freezeTimeOfDay(0.0)'); await a.waitForTimeout(2000);
  const night = await ev(`(() => { const s = window.__ac.sceneManager.scene; let amb = 0; s.traverse(o => { if (o.isAmbientLight) amb = o.intensity; }); return JSON.stringify({ fog: '#' + s.fog.color.getHexString(), amb: +amb.toFixed(3) }); })()`);
  await ev('window.__ac.skybox.setForceDaylight(true)'); await a.waitForTimeout(17000);
  const day = await ev(`(() => { const s = window.__ac.sceneManager.scene; let amb = 0; s.traverse(o => { if (o.isAmbientLight) amb = o.intensity; }); return JSON.stringify({ fog: '#' + s.fog.color.getHexString(), amb: +amb.toFixed(3) }); })()`);
  await ev('window.__ac.skybox.setForceDaylight(false)'); await ev('window.acDebug.freezeTimeOfDay(null)');
  out.S4 = { nightNoOption: JSON.parse(night as string), nightWithAlwaysDaylight: JSON.parse(day as string) };
}
// W6
{
  out.W6 = JSON.parse(await ev(`(() => { const som = window.__ac.serverObjectManager; let n = 0, off = 0, maxd = 0; for (const o of som.getAllObjects().values()) { if (!o.position || !o.mesh || o.wielderId) continue; n++; const d = Math.abs(o.worldY - o.position.z); if (d > 0.02) off++; maxd = Math.max(maxd, d); } return JSON.stringify({ objects: n, offFromServerZ: off, maxDelta: +maxd.toFixed(3) }); })()`) as string);
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
