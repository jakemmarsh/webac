/**
 * probe-phantom-walkers — "a couple of other players never stop moving their
 * feet" (BUG.phantom-walkers). Two live clients: A walks, then mid-stride
 * (d) stops normally, (b) teleports (@teleloc runs ACE Player.Teleport, the
 * same path a portal / recall takes), (c) runs out of B's visibility,
 * (a) logs out. B records every motion / position / delete it applies for A
 * and samples A's object (exists, lost-cell, drawn, motion, pose change).
 *
 * Step r/R (walk/turn/strafe/shift-walk → stop) needs the sender to pack like
 * the retail client (RawMotionState::Pack omits CurrentStyle in NonCombat and
 * CurrentHoldKey when None); our writeRawMotionState always sends both, so
 * the repro patched it behind globalThis.__retailRawMotion (not committed).
 *
 * Usage: AC_BASE=http://localhost:<vite>/ AC_BRIDGE=ws://localhost:<bridge> \
 *   npx tsx tools/probe-phantom-walkers.ts [d,b,c,a]
 * Accounts: AC_CLIENT_A / AC_CLIENT_B (default phantoma1 / phantomb1).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { adminCommand, shot } from './lib/game-session.ts';
import { openTwoClients, MEET_LOC, type Client } from './lib/two-client.ts';

const OUT = process.env.AC_PROBE_OUT ?? 'verification/phantom-walkers';
const steps = (process.argv[2] ?? 'd,b,c,a').split(',');

const HOOK_JS = (g: number) => `(() => {
  const som = window.__ac.serverObjectManager, g = ${g};
  const rec = window.__pw = { ev: [], t0: performance.now() };
  const t = () => Math.round(performance.now() - rec.t0);
  const wrap = (name, f) => { const o = som[name].bind(som); som[name] = (...a) => { try { f(...a); } catch {} return o(...a); }; };
  wrap('handleMovementEvent', (d) => { if (d.guid === g) rec.ev.push({ t: t(), k: 'motion' }); });
  wrap('applyParsedMotion', (guid, a, p) => { if (guid === g) rec.ev.push({ t: t(), k: 'parsed', type: p.movementType, auto: p.autonomous, fwd: p.forwardCommand.toString(16), fs: +(p.forwardSpeed || 0).toFixed(2) }); });
  wrap('updatePosition', (d) => { if (d.guid === g) rec.ev.push({ t: t(), k: 'pos', cell: (d.landblock >>> 0).toString(16), x: +d.x.toFixed(1), y: +d.y.toFixed(1), flags: d.flags }); });
  wrap('deleteObject', (guid) => { if (guid === g) rec.ev.push({ t: t(), k: 'DELETE' }); });
  wrap('setPhysicsState', (guid, s) => { if (guid === g) rec.ev.push({ t: t(), k: 'state', s: s.toString(16) }); });
  return true; })()`;

const SAMPLE_JS = (g: number) => `(() => {
  const som = window.__ac.serverObjectManager, o = som.objects.get(${g}), a = som.animatedObjects.get(${g});
  if (!o) return { exists: false };
  const parts = o.mesh ? o.mesh.children.filter((c) => /^part_\\d+$/.test(c.name)) : [];
  const sig = parts.reduce((s, c) => s + c.quaternion.x + c.quaternion.y * 3 + c.quaternion.z * 5, 0);
  return { exists: true, lostCell: !!o.lostCell, outOfWorld: !!o.outOfWorld, drawn: !!(o.mesh && o.mesh.visible && o.mesh.parent),
    cell: (o.objCellId >>> 0).toString(16), x: +o.worldX.toFixed(1), z: +o.worldZ.toFixed(1),
    fwd: a ? (a.motionManager.motion >>> 0).toString(16) : '-', sig };
})()`;

async function sample(b: Client, g: number, n: number, gap: number): Promise<unknown[]> {
  const out: Array<Record<string, unknown>> = [];
  let prev: number | null = null;
  for (let i = 0; i < n; i++) {
    const s = await b.page.evaluate(SAMPLE_JS(g)) as Record<string, unknown>;
    if (typeof s.sig === 'number') { s.poseDelta = prev === null ? 0 : +Math.abs((s.sig as number) - prev).toFixed(4); prev = s.sig as number; delete s.sig; }
    out.push(s);
    await b.page.waitForTimeout(gap);
  }
  return out;
}

async function events(b: Client): Promise<unknown[]> {
  const ev = await b.page.evaluate('JSON.stringify(window.__pw.ev.splice(0))') as string;
  return JSON.parse(ev);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { a, b, close } = await openTwoClients('phantom', {
    ...process.env,
    AC_CLIENT_A: process.env.AC_CLIENT_A ?? 'phantoma1', AC_CLIENT_A_CHAR: 'Phantoma',
    AC_CLIENT_B: process.env.AC_CLIENT_B ?? 'phantomb1', AC_CLIENT_B_CHAR: 'Phantomb',
  });
  const result: Record<string, unknown> = { a: a.name, b: b.name, aGuid: a.guid.toString(16) };
  const g = a.guid;
  try {
    await b.page.evaluate(HOOK_JS(g));
    await a.page.mouse.click(780, 300);
    const regroup = async () => {
      await adminCommand(a.page, `@teleloc ${MEET_LOC}`);
      await a.page.waitForTimeout(8000);
      await adminCommand(a.page, `@teletome ${b.name}`);
      await b.page.waitForTimeout(9000);
      await events(b);
    };
    for (const step of steps) {
      if (step === 'd') {
        await a.page.keyboard.down('w'); await a.page.waitForTimeout(2000); await a.page.keyboard.up('w');
        await a.page.waitForTimeout(3000);
        result.d = { ev: await events(b), after: await sample(b, g, 5, 400) };
        await shot(b.page, `${OUT}/d-stop-b.png`);
      } else if (step === 'b') {
        await a.page.keyboard.down('w'); await a.page.waitForTimeout(1500);
        await adminCommand(a.page, '@telepoi Arwic'); // far away
        await a.page.waitForTimeout(800); await a.page.keyboard.up('w');
        await b.page.waitForTimeout(3000);
        const after = await sample(b, g, 5, 400);
        await shot(b.page, `${OUT}/b-teleport-b.png`);
        await b.page.waitForTimeout(25000);
        const after30 = await sample(b, g, 2, 400);
        result.b = { ev: await events(b), after, after30 };
        await regroup();
      } else if (step === 'c') {
        // Face away (a quarter-second of turn), then run for ~45 s.
        await a.page.keyboard.down('w'); await a.page.waitForTimeout(45000); await a.page.keyboard.up('w');
        const aPos = await a.page.evaluate('window.acDebug.collisionState()');
        const after = await sample(b, g, 5, 400);
        await shot(b.page, `${OUT}/c-range-b.png`);
        result.c = { aPos, ev: await events(b), after };
        await b.page.waitForTimeout(25000);
        (result.c as Record<string, unknown>).after25 = await sample(b, g, 2, 400);
        await regroup();
      } else if (step === 'r' || step === 'R') {
        // Retail-client packing (RawMotionState::Pack omits CurrentStyle in
        // NonCombat) — ACE then broadcasts style 0 + no forward command for a stop.
        await a.page.evaluate('globalThis.__retailRawMotion = true');
        const variants: Array<[string, string[], number]> = [
          ['walk-stop', ['w'], 2000], ['turn-stop', ['w', 'a'], 1500], ['strafe-stop', ['z'], 1500],
          ['shift-walk-stop', ['Shift', 'w'], 2000], ['turn-only-stop', ['d'], 1200],
        ];
        const out: Record<string, unknown> = {};
        for (const [name, keys, ms] of variants) {
          for (const k of keys) await a.page.keyboard.down(k);
          await a.page.waitForTimeout(ms);
          for (const k of [...keys].reverse()) await a.page.keyboard.up(k);
          await a.page.waitForTimeout(2500);
          out[name] = { ev: await events(b), after: await sample(b, g, 4, 400) };
          await shot(b.page, `${OUT}/${step}-${name}-b.png`);
          console.log(name, JSON.stringify(out[name]));
        }
        result[step] = out;
      } else if (step === 'v') {
        // The observer logs in while A already stands still (after a walk).
        await a.page.keyboard.down('w'); await a.page.waitForTimeout(2000); await a.page.keyboard.up('w');
        await a.page.waitForTimeout(2000);
        await b.page.reload({ waitUntil: 'domcontentloaded' });
        for (let i = 0; i < 120 && !(await b.page.evaluate('!!(window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState().x > 0)').catch(() => false)); i++) await b.page.waitForTimeout(1000);
        await b.page.waitForTimeout(6000);
        result.v = { after: await sample(b, g, 4, 400) };
        await shot(b.page, `${OUT}/v-relog-b.png`);
      } else if (step === 'a') {
        await a.page.keyboard.down('w'); await a.page.waitForTimeout(1500);
        await a.page.evaluate('window.__ac.gameUI.callbacks.onLogout()').catch((e) => console.log('logout err', String(e)));
        await a.page.waitForTimeout(500); await a.page.keyboard.up('w');
        await b.page.waitForTimeout(8000);
        result.a = { ev: await events(b), after: await sample(b, g, 5, 400) };
        await shot(b.page, `${OUT}/a-logout-b.png`);
      }
      console.log(step, JSON.stringify(result[step]));
    }
  } finally {
    writeFileSync(`${OUT}/results.json`, JSON.stringify(result, null, 2));
    await close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
