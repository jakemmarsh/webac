/**
 * BUG.portal-arrival-keys-dead live probe: walk into portal wcid 1087
 * ("Outside Accursed Halls Portal", destination 0x3761000C [37.31 80.17 40]
 * facing south) with the keyboard on local ACE, then log the movement state
 * every animation frame for 30 s while pressing W / S / Z / C at set times:
 * held keys, MotionInterp state, the physics substeps the frame ran, the
 * collision result, any server MoveTo, the portal-space flags, the position
 * the client sends and every server position update.
 *
 *   BASE=http://localhost:3471/ ACCT=testacjs3 npx tsx tools/probe-portal-arrival-stuck.ts [walkin|teleloc]
 *
 * Its own deleted-at-exit browser profile (createRunProfile); deletes its spawns.
 * Never run it on testacjs.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { createRunProfile } from './lib/temp-profile.js';
import { waitFor, chatLine, deleteSpawnsNear, IN_WORLD_JS, SWIFTSHADER_ARGS } from './lib/game-session.js';

const base = process.env.BASE ?? 'http://localhost:3471/';
const bridge = process.env.BRIDGE ?? 'ws://localhost:9090';
const acct = process.env.ACCT ?? 'testacjs3';
if (acct === 'testacjs') throw new Error('never testacjs (Jake plays it)');
const mode = process.argv[2] ?? 'walkin';
const out = process.env.OUT ?? '/tmp/portal-arrival-stuck.json';
const PORTAL = 1087;

const profile = createRunProfile('acjs-portal-arrival-', { tool: 'probe-portal-arrival-stuck' });
const browser = await chromium.launchPersistentContext(profile.dir, { args: SWIFTSHADER_ARGS, viewport: { width: 1280, height: 720 } });
profile.setCloser(() => browser.close());
const page = browser.pages()[0] ?? await browser.newPage();
page.setDefaultTimeout(120_000);
const t0 = Date.now();
const ts = (): string => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
page.on('console', (m) => {
  const t = m.text();
  if (/PlayerTeleport|WeenieError|correction|MoveTo|UpdatePosition|teleport|ForcePos|position/i.test(t) && !/emitter|particle/i.test(t)) console.log(`${ts()} [page] ${t.slice(0, 220)}`);
});
const ev = <T = unknown>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
await page.goto(`${base}?ace&debug&bridge=${encodeURIComponent(bridge)}&account=${acct}&password=${acct}`, { waitUntil: 'commit' });
if (!(await waitFor(page, IN_WORLD_JS, { timeoutMs: 300_000, reloadEveryMs: 0 }))) throw new Error('never entered the world');
console.log(`${ts()} in world`);
await page.waitForTimeout(5000);
await page.mouse.click(640, 200);

async function hold(key: string, ms: number): Promise<void> {
  await ev(`window.__arrMark && window.__arrMark('down ${key}')`);
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
  await ev(`window.__arrMark && window.__arrMark('up ${key}')`);
}

// The per-frame logger (installed now, armed later).
await ev(`(() => {
  const ac = window.__ac, dbg = window.acDebug;
  const rows = []; window.__arrRows = rows; window.__arrOn = false;
  window.__arrMark = (m) => rows.push({ t: performance.now(), mark: m });
  const r2 = (v) => typeof v === 'number' ? +v.toFixed(3) : v;
  const tick = () => {
    if (window.__arrOn) {
      const c = dbg.collisionState(); const cc = ac.cameraController; const a = ac.animController; const fs = ac.frameStats();
      const oc = ac.outdoorCollision;
      rows.push({ t: performance.now(),
        x: r2(c.x), z: r2(c.z), feet: r2(c.feetY), floor: r2(c.lastFloor), onGround: c.onGround, cell: (c.cellId >>> 0).toString(16), srv: c.serverFrame ? [r2(c.serverFrame.x ?? c.serverFrame.origin?.x), r2(c.serverFrame.y ?? c.serverFrame.origin?.y)] : null,
        loginComplete: c.loginComplete, ps: !!ac.gameUI.worldHiddenByPortalSpace,
        yaw: r2(cc.playerYaw), sub: [...(cc.substateList || [])], turn: [...(cc.turnList || [])], side: [...(cc.sidestepList || [])], auto: cc.autoRun, byServer: cc.controlledByServer,
        anim: a ? { air: a.airborne, pend: a.motionsPending } : null,
        physDt: r2(fs.lastPhysDt), rawDt: r2(fs.lastRawDt), dropped: fs.droppedFrames,
        sliding: c.sliding, stuck: c.slopeStuck, stepUp: r2(c.outdoorStepUp), cn: oc.collisionNormal ? [r2(oc.collisionNormal.x), r2(oc.collisionNormal.z)] : null,
        cam: [r2(ac.sceneManager.camera.position.x), r2(ac.sceneManager.camera.position.z)], keys: [...(cc.keys || [])], kt: [...(cc.keyTranslations || new Map())].map(([a, b]) => a + '>' + b),
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`);

console.log(`${ts()} @telepoi Holtburg`);
await chatLine(page, '@telepoi Holtburg');
await page.waitForTimeout(12_000);
await waitFor(page, `!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 60_000, reloadEveryMs: 0 });
await page.waitForTimeout(6000);
await deleteSpawnsNear(page, [PORTAL], 40);
console.log(`${ts()} translator KeyX=${await ev("window.__ac.cameraController.keyTranslator('KeyX')")} KeyS=${await ev("window.__ac.cameraController.keyTranslator('KeyS')")} KeyW=${await ev("window.__ac.cameraController.keyTranslator('KeyW')")}`);
if (process.env.HOLTBURG_S) { await ev(`window.__arrOn = true`); await hold('KeyS', 1500); await page.waitForTimeout(1000); await hold('KeyW', 1500); await page.waitForTimeout(1000); await ev(`window.__arrMark('holtburg done')`); }

if (mode === 'walkin') {
  await chatLine(page, `@create ${PORTAL}`);
  await page.waitForTimeout(2500);
  await ev(`window.__arrOn = true`);
  await hold('KeyW', 2000);
  await waitFor(page, `!!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 8000, reloadEveryMs: 0 });
} else {
  await ev(`window.__arrOn = true`);
  await chatLine(page, '@teleloc 0x3761000C [37.31 80.17 40.0] 0 0 0 -1');
  await waitFor(page, `!!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 8000, reloadEveryMs: 0 });
}
await ev(`window.__arrMark('portal space up')`);
await waitFor(page, `!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 60_000, reloadEveryMs: 0 });
await ev(`window.__arrMark('portal space down')`);
console.log(`${ts()} arrived ${JSON.stringify(await ev('window.acDebug.collisionState()'))}`);
await page.waitForTimeout(3000);
// Retail default keys (KeyMap 0x14000000): W forward, X back up, S Stop Moving, Z / C strafe, A / D turn.
const seq = (process.env.SEQ ?? 'KeyW:1500,KeyS:2500,KeyX:2000,KeyW:1500,KeyA:120,KeyW:2500').split(',');
for (const step of seq) {
  const [key, ms] = step.split(':');
  await hold(key, Number(ms));
  await page.waitForTimeout(1200);
  console.log(`${ts()} after ${step}: ${JSON.stringify(await ev('(() => { const c = window.acDebug.collisionState(); return { x: +(c.x % 192).toFixed(2), y: +(c.z % 192).toFixed(2), yaw: +c.playerYaw.toFixed(3) }; })()'))}`);
}
await ev(`window.__arrOn = false`);
const rows = await ev<unknown[]>(`window.__arrRows`);
writeFileSync(out, JSON.stringify(rows));
console.log(`${ts()} wrote ${rows.length} rows to ${out}; final ${JSON.stringify(await ev('window.acDebug.collisionState()'))}`);
await chatLine(page, '@telepoi Holtburg');
await page.waitForTimeout(12_000);
await waitFor(page, `!window.__ac.gameUI.worldHiddenByPortalSpace`, { timeoutMs: 60_000, reloadEveryMs: 0 });
await page.waitForTimeout(4000);
console.log(`${ts()} deleted ${await deleteSpawnsNear(page, [PORTAL], 40)} spawn(s)`);
await browser.close();
await profile.dispose?.();
process.exit(0);
