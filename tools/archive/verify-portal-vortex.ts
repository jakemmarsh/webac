/**
 * verify-portal-vortex — live verification for VISUAL.portal-renders-opaque-white.
 *
 * Teleports near the Holtburg "Portal to Redspire" (wcid 11960), then:
 *  1. Screenshots at arrival, +5s and +35s — the retail DAT vortex (endless
 *     emitters 0x320002CD/0x320002D6) must render as an additive purple
 *     glow, NOT opaque white concentric panes, and must PERSIST past the
 *     old bounded ~2.9s maxAge.
 *  2. Programmatic evidence (SwiftShader-independent): walks the scene for
 *     the vortex ParticleSystems and asserts their shader materials carry
 *     uHasMap=1 + AdditiveBlending + live particle counts at every sample.
 *
 * Output: verification/playtest/<utc>-portal-vortex/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=vortex1';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-portal-vortex`);

// Holtburg Portal to Redspire (probe-portal-decisive.ts) — stand ~8m south.
const PORTAL = { cell: '0xA9B40000', x: 27.325, y: 137.487, z: 66.5 };
const STAND = { x: 27.325, y: 129.0, z: 66.2 };

const steps: Array<Record<string, unknown>> = [];

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

/** Scene-walk evidence: particle Points near the portal + material facts. */
async function vortexState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const THREEAdditive = 2; // THREE.AdditiveBlending
    const sm = window.__ac.sceneManager;
    const portal = window.acDebug.getObjects().find(o => /Portal to Redspire/.test(o.name || ''));
    const out = [];
    sm.scene.traverse((o) => {
      if (!o.isPoints || !o.material || !o.material.uniforms) return;
      const u = o.material.uniforms;
      if (portal && portal.pos) {
        const dx = o.position.x - portal.pos.x;
        const dz = o.position.z - portal.pos.z;
        if (Math.hypot(dx, dz) > 12) return;
      }
      out.push({
        name: o.name,
        hasMap: u.uHasMap ? u.uHasMap.value : -1,
        additive: o.material.blending === THREEAdditive,
        drawCount: o.geometry.drawRange.count,
        posX: Math.round(o.position.x * 10) / 10,
        posY: Math.round(o.position.y * 100) / 100,
        posZ: Math.round(o.position.z * 10) / 10,
      });
    });
    return { systems: out, portalSeen: !!portal, portalGuid: portal ? portal.guid : 0 };
  })()`) as Promise<Record<string, unknown>>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
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

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[vortex] char-create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(8000);

  // Teleport a few meters south of the portal so it fills the view; the
  // fresh CreateObject fires the DefaultScript (vortex) on arrival.
  await page.evaluate(`window.acDebug.tele('${PORTAL.cell}', ${STAND.x}, ${STAND.y}, ${STAND.z})`);
  await page.waitForTimeout(12_000);

  // Aim the camera at the portal by sweeping yaw offsets and keeping the
  // one that projects the portal closest to screen center (convention-proof:
  // the camera follows the player heading, which teleport leaves arbitrary).
  // Empirically calibrated against a yaw panorama (2026-08-21): with total
  // camera yaw θ = playerYaw + cameraYawOffset, the on-screen bearing
  // matches the compass at θ·180/π degrees (N=0 → E=90 clockwise), and a
  // world delta (dx, dz) from the PLAYER (not the boom camera) lies at
  // bearing atan2(dx, dz).
  const AIM_SRC = `(() => {
    const portal = window.acDebug.getObjects().find(o => /Portal to Redspire/.test(o.name || ''));
    if (!portal || !portal.pos) return 'no-portal';
    const cc = window.__ac.cameraController;
    const me = window.acDebug.collisionState();
    const dx = portal.pos.x - me.x;
    const dz = portal.pos.z - me.z;
    const yaw = Math.atan2(dx, dz);
    cc.cameraYawOffset = yaw - cc.playerYaw;
    return { yaw, dx: Math.round(dx * 10) / 10, dz: Math.round(dz * 10) / 10 };
  })()`;
  let aimed: unknown = 'pending';
  for (let i = 0; i < 3; i++) {
    aimed = await page.evaluate(AIM_SRC);
    console.log(`[vortex] camera aim: ${JSON.stringify(aimed)}`);
    await page.waitForTimeout(1_500);
    if (aimed && typeof aimed === 'object') break;
  }

  const s0 = await vortexState(page);
  steps.push({ step: 't0-arrival', ...s0 });
  console.log('[vortex] t0:', JSON.stringify(s0));
  await shot(page, '01-portal-t0');

  await page.waitForTimeout(5_000);
  const s5 = await vortexState(page);
  steps.push({ step: 't5s', ...s5 });
  console.log('[vortex] t+5s:', JSON.stringify(s5));
  await shot(page, '02-portal-t5s');

  // Past the old bounded ~2.9s maxAge by an order of magnitude — the
  // endless emitters must still be alive and emitting.
  await page.waitForTimeout(30_000);
  const s35 = await vortexState(page);
  steps.push({ step: 't35s', ...s35 });
  console.log('[vortex] t+35s:', JSON.stringify(s35));
  await shot(page, '03-portal-t35s');

  // Close-up: stand right beside the portal footprint (mirrors the
  // 2026-08-20 white-pane close-up 02-stand-in-portal.png for a direct
  // before/after) — near enough that the vortex fills the frame, offset
  // enough not to trigger the walk-in teleport.
  await page.evaluate(`window.acDebug.tele('${PORTAL.cell}', ${PORTAL.x + 3.5}, ${PORTAL.y - 3.5}, ${PORTAL.z})`);
  await page.waitForTimeout(6_000);
  const aimClose = await page.evaluate(AIM_SRC);
  console.log(`[vortex] close aim: ${JSON.stringify(aimClose)}`);
  await page.waitForTimeout(2_000);
  const sClose = await vortexState(page);
  steps.push({ step: 'closeup', ...sClose });
  console.log('[vortex] closeup:', JSON.stringify(sClose));
  await shot(page, '04-portal-closeup');

  await browser.close();

  type Sys = { name: string; hasMap: number; additive: boolean; drawCount: number };
  const vortexOk = (s: Record<string, unknown>) => {
    const systems = s.systems as Sys[];
    // The live ACE wire sends a PlayScript override for wcid 11960 (resolved
    // per FAITHFUL.376 through the setup's DefaultScriptTable), so the
    // rendered emitters are the 0x320009xx portal-purple set rather than the
    // bare setup chain's 0x320002CD/D6 — either way every particle system at
    // the portal must be a TEXTURED emitter sprite, the additive glow layers
    // must be present, and the dense layers must be saturated (the old code
    // rendered all of these as untextured white squares and killed them at
    // ~2.9s).
    const emitters = systems.filter(x => /^particles_32/.test(x.name));
    const additive = emitters.filter(x => x.additive);
    return emitters.length >= 2
      && emitters.every(x => x.hasMap === 1)
      && additive.length >= 2
      && additive.some(x => x.drawCount >= 10);
  };
  const verdict = {
    portalSeen: [s0, s5, s35].every(s => s.portalSeen),
    texturedAdditiveAtAllSamples: [s0, s5, s35].every(vortexOk),
    persistsPastBoundedAge: vortexOk(s35),
  };
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({ utc: UTC, portal: PORTAL, steps, verdict }, null, 2));
  console.log(`[vortex] VERDICT: ${JSON.stringify(verdict)}`);
  console.log(`[vortex] done — wrote ${OUT}`);
  if (!verdict.texturedAdditiveAtAllSamples || !verdict.persistsPastBoundedAge) process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
