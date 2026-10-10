/**
 * probe-portal-hold-physics — live check for RECON.transition-stepup-stepdown-port.a.a.
 *
 * Retail SmartBox::UseTime @ 00455410 skips CPhysics::UseTime while the
 * portal-space gate holds for a destination's cells (blocking_for_cells), so
 * the player does not move at the spot the teleport left; physics runs again
 * once the arrival is applied, behind the rest of the tunnel. The gate holds
 * only on streamed DATs, so this probe runs the production streamed set
 * against the local stack: it holds the run key, teleports to an unvisited
 * POI and samples the player's position, the gate and the tunnel every 50 ms.
 *
 * Usage: npx tsx tools/probe-portal-hold-physics.ts [poi=Linvak Tukal] [out=verification/portal-hold-physics]
 *   (dev server + bridge + ACE; testacjs needs an admin character)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, gameUrl, adminCommand, REPO } from './lib/game-session.js';

const poi = process.argv[2] ?? 'Linvak Tukal';
const OUT = join(REPO, process.argv[3] ?? 'verification/portal-hold-physics');
mkdirSync(OUT, { recursive: true });
const DAT_SET = process.env.AC_DAT_SET ?? 'https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json';
const url = `${gameUrl({ cb: 'portal-hold' })}&datSet=${encodeURIComponent(DAT_SET)}`;

type Sample = { t: number; x: number; z: number; feetY: number | null; holding: boolean; tunnel: boolean };
const SAMPLE_JS = `(() => {
  const c = window.acDebug.collisionState();
  const g = window.__sessionEventGate;
  const ui = window.__ac && window.__ac.gameUI;
  const tunnel = !!(ui && ui.portalSpaceState); // TeleportAnimState: 0 = TAS_OFF
  return { t: performance.now(), x: c.x, z: c.z, feetY: c.feetY ?? null, holding: !!(g && g.isHolding), tunnel };
})()`;

const { browser, page } = await enterWorld({ url, timeoutMs: 480_000, settleMs: 8000 });
const log: string[] = [];
page.on('console', (m) => { const t = m.text(); if (/portal-space gate|Teleport →/.test(t)) log.push(t.slice(0, 240)); });
const samples: Sample[] = [];
try {
  await page.mouse.click(780, 300); // focus the world for the run key
  await page.keyboard.press('Escape');
  await page.keyboard.down('w');
  await page.waitForTimeout(1500);
  await adminCommand(page, `@telepoi ${poi}`);
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    samples.push(await page.evaluate(SAMPLE_JS) as Sample);
    await page.waitForTimeout(50);
  }
  await page.keyboard.up('w');
  await page.screenshot({ path: join(OUT, 'arrival.png') });
} finally {
  await browser.close().catch(() => {});
}

// Movement while the gate held (at the departure spot) and after it released.
const held = samples.filter((s) => s.holding);
const moved = (a: Sample[]) => a.length < 2 ? 0 : Math.hypot(a[a.length - 1].x - a[0].x, a[a.length - 1].z - a[0].z);
const report = {
  poi, datSet: DAT_SET,
  heldSamples: held.length,
  heldSeconds: held.length ? (held[held.length - 1].t - held[0].t) / 1000 : 0,
  movedWhileHeldM: moved(held),
  feetYRangeWhileHeld: held.length ? [Math.min(...held.map((s) => s.feetY ?? 0)), Math.max(...held.map((s) => s.feetY ?? 0))] : null,
  log,
  samples,
};
writeFileSync(join(OUT, 'probe.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, samples: undefined, log: log.slice(0, 12) }, null, 2));
