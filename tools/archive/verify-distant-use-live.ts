/**
 * verify-distant-use-live — live in-cloud verification for
 * BUG.distant-use-silent-noop (retail approach-then-use).
 *
 * Repro being fixed (verification/playtest/2026-08-20T13-01-16-032Z-magic-portal):
 * dblclick 'Portal to Redspire' at ~11-14m → 'Sent Use (0x0036)' immediately →
 * UseDone(0) ~6s later, zero movement, zero teleport.
 *
 * Expected now: the Use arms the auto-approach ('Use approach → walking'
 * console line, NO immediate Sent Use), the player walks toward the portal,
 * and on arrival either the walked-in position triggers the server's portal
 * collision or the deferred Use goes out inside UseRadius — either way the
 * player teleports (position jump ≫ 1000m to the Redspire region).
 *
 * Output: verification/playtest/<utc>-distant-use/
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=distantuse';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-distant-use`);

// Holtburg → Redspire portal (cell 0xA9B4). Stand ~12m south of it, matching
// the original 11-14m repro distance.
const PORTAL_CELL = '0xA9B40000';
const PORTAL = { x: 27.325, y: 137.487, z: 66.5 };
const STAND_OFF = { x: 27.325, y: 125.5, z: 66.2 };

const steps: Array<Record<string, unknown>> = [];
const failures: string[] = [];
const consoleLines: string[] = [];

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function collision(page: Page): Promise<Record<string, number>> {
  return page.evaluate(`window.acDebug.collisionState()`) as Promise<Record<string, number>>;
}

async function talk(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(text)})`);
  console.log(`[talk] ${text}`);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}

async function portalObj(page: Page): Promise<{ guid: number; name: string; dist: number; useRadius: number } | null> {
  return page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    for (const [guid, o] of window.__ac.serverObjectManager.getAllObjects()) {
      if (o.name && /Portal to Redspire/.test(o.name) && o.mesh) {
        return { guid, name: o.name, useRadius: o.useRadius,
                 dist: Math.hypot(o.worldX - me.x, o.worldZ - me.z) };
      }
    }
    return null;
  })()`) as any;
}

async function screenPos(page: Page, guid: number, yOff: number): Promise<{ x: number; y: number; behind: boolean } | null> {
  return page.evaluate(`(() => {
    const o = window.__ac.serverObjectManager.getObject(${guid});
    if (!o || !o.mesh) return null;
    const sm = window.__ac.sceneManager;
    const rect = sm.renderer.domElement.getBoundingClientRect();
    const v = o.mesh.position.clone(); v.y += ${yOff};
    v.project(sm.camera);
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height, behind: v.z > 1 };
  })()`) as any;
}

function record(step: string, data: Record<string, unknown>, failure?: string | null): void {
  steps.push({ step, ...data });
  console.log(`[verify] ${step}: ${JSON.stringify(data)}${failure ? ` FAIL: ${failure}` : ''}`);
  if (failure) failures.push(`${step}: ${failure}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', msg => {
    const t = msg.text();
    if (/Sent Use|Use approach|Use suppressed|UseDone|Position correction|PlayerTeleport|tele:/.test(t)) {
      consoleLines.push(t.slice(0, 250));
      console.log(`[console] ${t.slice(0, 200)}`);
    }
  });

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[verify] create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await shot(page, '00-never-entered');
    await browser.close();
    throw new Error('never entered world');
  }
  await page.waitForTimeout(10_000);

  // ── Position: ~12m from the Redspire portal ──
  await page.evaluate(`window.acDebug.tele('${PORTAL_CELL}', ${STAND_OFF.x}, ${STAND_OFF.y}, ${STAND_OFF.z})`);
  await page.waitForTimeout(12_000);
  const c0 = await collision(page);
  let portal = await portalObj(page);
  record('setup', { collision: c0, portal }, portal ? null : 'Portal to Redspire not tracked with a mesh');
  await shot(page, '01-standing-distant');
  if (!portal) { await browser.close(); writeFileSync(join(OUT, 'observations.json'), JSON.stringify({ utc: UTC, verdict: 'FAIL', steps, failures, consoleLines }, null, 2)); throw new Error('no portal'); }
  if (portal.dist < 8) {
    record('setup-distance-warning', { dist: portal.dist }, 'closer than the 11-14m repro band — still out of use range, proceeding');
  }

  // ── Fire the Use: real dblclick if the portal projects on screen, else
  //    the __ac.useObject hook (same sendUseAction funnel the dblclick uses).
  let fired = 'none';
  for (const yOff of [1.2, 0.8, 1.6, 0.4, 2.0]) {
    const sp = await screenPos(page, portal.guid, yOff);
    if (sp && !sp.behind && sp.x > 10 && sp.x < VIEW.width - 10 && sp.y > 40 && sp.y < VIEW.height - 10) {
      await page.mouse.dblclick(sp.x, sp.y);
      fired = `dblclick@${sp.x.toFixed(0)},${sp.y.toFixed(0)}`;
      break;
    }
  }
  if (fired === 'none') {
    await page.evaluate(`window.__ac.useObject(${portal.guid})`);
    fired = 'useObject-hook';
  }
  record('use-fired', { via: fired, distAtFire: portal.dist });

  // ── Watch the approach: sample distance ~1/s; success = teleport jump ──
  const jumped = (a: Record<string, number>, b: Record<string, number>) =>
    Math.hypot((b.x ?? 0) - (a.x ?? 0), (b.z ?? 0) - (a.z ?? 0)) > 1000;
  const trajectory: Array<{ t: number; x: number; z: number; portalDist: number | null }> = [];
  let arrived = false;
  const t0 = Date.now();
  let midShotDone = false;
  while (Date.now() - t0 < 45_000) {
    const c = await collision(page);
    const p = await portalObj(page);
    trajectory.push({ t: Date.now() - t0, x: c.x, z: c.z, portalDist: p ? p.dist : null });
    if (jumped(c0, c)) { arrived = true; break; }
    if (!midShotDone && p && p.dist < portal.dist - 4) { await shot(page, '02-mid-walk'); midShotDone = true; }
    await page.waitForTimeout(1000);
  }
  const cEnd = await collision(page);
  await page.waitForTimeout(8_000); // let the destination stream in for the screenshot
  await shot(page, '03-final');

  const walkedIn = trajectory.some(s => s.portalDist !== null && s.portalDist < portal.dist - 3);
  const armedApproach = consoleLines.some(l => l.includes('Use approach → walking'));
  record('approach-result', {
    arrived, walkedIn, armedApproach,
    startPos: { x: c0.x, z: c0.z }, endPos: { x: cEnd.x, z: cEnd.z },
    trajectory: trajectory.slice(0, 40),
  }, arrived ? null : 'player never teleported — approach-then-use did not complete');
  if (!armedApproach) failures.push('console never showed the approach arming line');

  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';
  console.log(`[verify] VERDICT: ${verdict}${failures.length ? ' — ' + failures.join(' | ') : ''}`);
  await browser.close();
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({ utc: UTC, verdict, steps, failures, consoleLines }, null, 2));
  console.log(`[verify] done — wrote ${OUT}`);
  if (verdict !== 'PASS') process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
