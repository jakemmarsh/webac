/**
 * BUG.physicsstate-nodraw-ignored — live verification.
 *
 * Two real clients on the ACE stack:
 *   - page A: testacjs (accessLevel 5) — the cloaker.
 *   - page B: testacjs2 (player) — the observer whose renderer is under test.
 *
 * ACE's @cloak on (SentinelCommands.cs:29 → Player_Tracking.cs HandleCloak
 * :196-202) sets NoDraw=true and EnqueueBroadcastPhysicsState(), then in the
 * next chain action broadcasts DeleteObject. The SetState and DeleteObject
 * can land in the same frame, so the observer instruments
 * serverObjectManager.setPhysicsState to record — synchronously, right after
 * the shipped code runs on the live wire message — whether a SetState
 * carrying NoDraw (0x20) left the admin's mesh invisible while the object
 * was still in the table. Pre-fix, meshVisible stayed true at that instant
 * (only Hidden 0x4000 was consulted).
 *
 * @cloak off (DeCloak) then re-broadcasts, and the observer must see the
 * admin drawn again.
 *
 * Evidence: verdict.json + screenshots in verification/nodraw-cloak/.
 */
import { chromium, Browser, Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const OUT = join(REPO, 'verification', 'nodraw-cloak');
// Wizard names used only when the account has no character yet; the actual
// in-world names are read back from each page's playerState after login
// (the bundle DB may carry a pre-existing character, e.g. 'Perf Tester').
const ADMIN_CREATE_NAME = 'Nodraw Admin';
const OBSERVER_CREATE_NAME = 'Nodraw Observer';
const NODRAW = 0x20;

async function ownName(page: Page): Promise<string> {
  const n = await page.evaluate(`window.__ac.playerState.name`) as string;
  if (!n) throw new Error('playerState.name empty');
  return n;
}

function url(account: string): string {
  return `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=${account}&password=${account}&cb=nodraw-${account}`;
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page, name: string): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = ${JSON.stringify(name)};
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function loginLoop(page: Page, tag: string, charName: string): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      const created = await driveCharacterCreate(page, charName);
      if (created !== 'not-at-create') {
        console.log(`[nodraw-live] ${tag}: scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 90_000) {
      console.log(`[nodraw-live] ${tag}: not in world yet — reloading (phantom-session retry)`);
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
      createSent = false;
    }
    await page.waitForTimeout(3000);
  }
  throw new Error(`${tag} never entered world within 360s`);
}

interface ObjState { present: boolean; physicsState: number | null; meshVisible: boolean | null }

async function observedState(page: Page, name: string): Promise<ObjState> {
  return page.evaluate(`(() => {
    const mgr = window.__ac && window.__ac.serverObjectManager;
    if (!mgr) return { present: false, physicsState: null, meshVisible: null };
    let found = null;
    mgr.getAllObjects().forEach((o) => { if (o.name === ${JSON.stringify(name)}) found = o; });
    if (!found) return { present: false, physicsState: null, meshVisible: null };
    return {
      present: true,
      physicsState: found.physicsState,
      meshVisible: found.mesh ? found.mesh.visible : null,
    };
  })()`) as Promise<ObjState>;
}

/** Wait until the render loop has produced >= n new frames (SwiftShader
 *  frames can take seconds — a wall-clock wait alone can screenshot a stale
 *  canvas; run 3 of this tool captured 3 byte-identical PNGs that way). */
async function awaitFrames(page: Page, n: number, timeoutMs = 90_000): Promise<number> {
  const start = await page.evaluate(`window.__ac.frameStats().frames`) as number;
  const deadline = Date.now() + timeoutMs;
  let now = start;
  while (Date.now() < deadline) {
    now = await page.evaluate(`window.__ac.frameStats().frames`) as number;
    if (now - start >= n) return now - start;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`[nodraw-live] WARN: only ${now - start}/${n} frames rendered in ${timeoutMs}ms`);
  return now - start;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });

  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  for (const p of [pageA, pageB]) {
    p.setDefaultTimeout(120000);
    p.on('dialog', d => void d.dismiss());
  }

  console.log('[nodraw-live] logging in admin (A) …');
  await pageA.goto(url('testacjs'), { waitUntil: 'domcontentloaded' });
  await loginLoop(pageA, 'A', ADMIN_CREATE_NAME);
  console.log('[nodraw-live] A in world. logging in observer (B) …');
  await pageB.goto(url('testacjs2'), { waitUntil: 'domcontentloaded' });
  await loginLoop(pageB, 'B', OBSERVER_CREATE_NAME);
  console.log('[nodraw-live] B in world.');
  await pageA.waitForTimeout(5000);

  const ADMIN_NAME = await ownName(pageA);
  const observerName = await ownName(pageB);
  console.log(`[nodraw-live] admin char='${ADMIN_NAME}', observer char='${observerName}'`);

  // Move the pair to open outdoor ground — the training-academy spawn rooms
  // are cramped enough that B's third-person camera collides with walls and
  // the screenshots show nothing but blurred wall (runs 1/3/4 of this tool).
  await pageA.evaluate(`window.acDebug.sendTalk('@telepoi holtburg')`);
  await pageA.waitForTimeout(12000);
  await pageA.evaluate(`window.acDebug.sendTalk('@teletome ${observerName}')`);
  await waitFor(async () => (await observedState(pageB, ADMIN_NAME)).present, 90_000,
    `B sees '${ADMIN_NAME}' after @teletome`);
  await pageB.waitForTimeout(5000);

  // Separate the two (teleto lands A on top of B) so the admin model is
  // actually in frame, then aim B's camera at A. Real key input on A.
  await pageA.keyboard.down('w');
  await pageA.waitForTimeout(2000);
  await pageA.keyboard.up('w');
  await pageA.waitForTimeout(3000);
  const aimed = await pageB.evaluate(`(() => {
    const mgr = window.__ac.serverObjectManager;
    let a = null;
    mgr.getAllObjects().forEach((o) => { if (o.name === ${JSON.stringify(ADMIN_NAME)}) a = o; });
    if (!a) return 'admin-gone';
    const cs = window.acDebug.collisionState();
    const dx = a.worldX - cs.x, dz = a.worldZ - cs.z;
    // CameraController forward = (-sin(yaw), -cos(yaw)) in three.js x/z.
    // Offset by 0.4 rad so the admin lands off-center in frame — dead-on
    // aim hides them exactly behind the observer's own third-person model.
    const yaw = Math.atan2(-dx, -dz) + 0.4;
    window.acDebug.setPlayerYaw(yaw);
    return { yaw, dist: Math.hypot(dx, dz) };
  })()`);
  console.log('[nodraw-live] B aimed at A:', JSON.stringify(aimed));
  await awaitFrames(pageB, 3);

  // Project the admin's mesh into B's screen space so the evidence can be
  // cropped to the spot where the model must appear/disappear.
  const adminScreen = await pageB.evaluate(`(() => {
    const mgr = window.__ac.serverObjectManager;
    let a = null;
    mgr.getAllObjects().forEach((o) => { if (o.name === ${JSON.stringify(ADMIN_NAME)}) a = o; });
    if (!a || !a.mesh) return null;
    const cam = window.__ac.sceneManager.camera;
    const v = a.mesh.position.clone();
    v.y += 1.0; // chest height
    v.project(cam);
    return {
      x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
      y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
      inFront: v.z < 1,
    };
  })()`) as { x: number; y: number; inFront: boolean } | null;
  console.log('[nodraw-live] admin screen pos on B:', JSON.stringify(adminScreen));
  const crop = adminScreen && adminScreen.inFront
    ? { x: Math.max(0, adminScreen.x - 150), y: Math.max(0, adminScreen.y - 180), width: 300, height: 360 }
    : null;

  const before = await observedState(pageB, ADMIN_NAME);
  console.log('[nodraw-live] B sees A before cloak:', JSON.stringify(before));
  await pageB.screenshot({ path: join(OUT, '01-observer-before-cloak.png') });
  if (crop) await pageB.screenshot({ path: join(OUT, '01-admin-closeup-before.png'), clip: crop });

  // Instrument the observer's shipped setPhysicsState so we capture the
  // state of the world synchronously after each live SetState applies.
  await pageB.evaluate(`(() => {
    const mgr = window.__ac.serverObjectManager;
    window.__nodrawEvents = [];
    if (!mgr.__nodrawPatched) {
      const orig = mgr.setPhysicsState.bind(mgr);
      mgr.setPhysicsState = (guid, state, seq) => {
        orig(guid, state, seq);
        let o = null;
        mgr.getAllObjects().forEach((c, g) => { if (g === guid) o = c; });
        window.__nodrawEvents.push({
          guid, state,
          present: !!o,
          name: o ? o.name : null,
          meshVisible: o && o.mesh ? o.mesh.visible : null,
          t: performance.now(),
        });
      };
      mgr.__nodrawPatched = true;
    }
  })()`);

  console.log('[nodraw-live] A: @cloak on');
  await pageA.evaluate(`window.acDebug.sendTalk('@cloak on')`);
  await pageB.waitForTimeout(4000);
  await awaitFrames(pageB, 3);
  const events = await pageB.evaluate(`window.__nodrawEvents`) as Array<{
    guid: number; state: number; present: boolean; name: string | null;
    meshVisible: boolean | null; t: number;
  }>;
  console.log('[nodraw-live] observer SetState events:', JSON.stringify(events));
  const afterCloak = await observedState(pageB, ADMIN_NAME);
  console.log('[nodraw-live] B sees A after cloak:', JSON.stringify(afterCloak));
  await pageB.screenshot({ path: join(OUT, '02-observer-during-cloak.png') });
  if (crop) await pageB.screenshot({ path: join(OUT, '02-admin-closeup-during.png'), clip: crop });

  // The decisive event: a live SetState carrying NoDraw applied to the
  // admin's object left its mesh invisible while still in the table.
  const nodrawEvent = events.find(e =>
    e.name === ADMIN_NAME && (e.state & NODRAW) !== 0 && e.present);
  const nodrawHidMesh = !!nodrawEvent && nodrawEvent.meshVisible === false;

  console.log('[nodraw-live] A: @cloak off');
  await pageA.evaluate(`window.acDebug.sendTalk('@cloak off')`);
  let afterDecloak: ObjState = { present: false, physicsState: null, meshVisible: null };
  try {
    await waitFor(async () => {
      afterDecloak = await observedState(pageB, ADMIN_NAME);
      return afterDecloak.present && afterDecloak.meshVisible === true;
    }, 30_000, 'B sees A drawn again after @cloak off');
  } catch (e) {
    console.log(`[nodraw-live] ${(e as Error).message}`);
  }
  console.log('[nodraw-live] B sees A after decloak:', JSON.stringify(afterDecloak));
  await awaitFrames(pageB, 3);
  await pageB.screenshot({ path: join(OUT, '03-observer-after-decloak.png') });
  if (crop) await pageB.screenshot({ path: join(OUT, '03-admin-closeup-after.png'), clip: crop });

  const checks = {
    adminVisibleBeforeCloak: before.present && before.meshVisible === true,
    liveSetStateCarriedNoDraw: !!nodrawEvent,
    nodrawHidMeshWhileStillPresent: nodrawHidMesh,
    adminGoneOrHiddenAfterCloak: !afterCloak.present || afterCloak.meshVisible === false,
    adminDrawnAgainAfterDecloak: afterDecloak.present && afterDecloak.meshVisible === true,
  };
  const pass = Object.values(checks).every(Boolean);
  const verdict = {
    pass, checks, before, afterCloak, afterDecloak,
    nodrawEvent: nodrawEvent ?? null,
    allEvents: events,
    when: new Date().toISOString(),
  };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2));
  console.log(`[nodraw-live] ${pass ? 'PASS' : 'FAIL'} — ${JSON.stringify(checks)}`);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch(err => { console.error('[nodraw-live] fatal:', err); process.exit(2); });
