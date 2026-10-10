/**
 * probe-closed-door-block — live check for RECON.closed-doors-walkthrough.
 *
 * Retail CPhysicsObj::FindObjCollisions @ 0050f050: a server object whose
 * PhysicsState has HasPhysicsBSP (a closed door) blocks by its part BSPs; an
 * open door (ACE Door.Open → Ethereal) does not. The probe stands 3 m in
 * front of the nearest closed Holtburg door, faces it, holds forward for
 * 3 s, and records whether the character crossed the door's plane; then it
 * Uses the door (opens it) and walks again.
 *
 * Usage: npx tsx tools/probe-closed-door-block.ts   (dev server + bridge + ACE)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, telepoi, teleloc, collisionState, REPO } from './lib/game-session.js';

const OUT = join(REPO, 'verification', 'recon-closed-doors');
mkdirSync(OUT, { recursive: true });
const { browser, page } = await enterWorld();
const report: Record<string, unknown> = {};
try {
  await telepoi(page, 'holtburg');
  const me = await collisionState(page);
  type Obj = { guid: number; name: string; pos?: { x: number; y: number; z: number } };
  const objs = await page.evaluate('window.acDebug.getObjects()') as Obj[];
  const doors = objs.filter((o) => /door/i.test(o.name) && o.pos)
    .map((o) => ({ ...o, d: Math.hypot(o.pos!.x - me.x, o.pos!.z - me.z) }))
    .sort((a, b) => a.d - b.d);
  report.doorsSeen = doors.length;
  let done = false;
  for (const door of doors.slice(0, 6)) {
    const ac = await page.evaluate(`window.acDebug.objectAcPosition(${door.guid})`) as {
      position: { landblock: number; x: number; y: number; z: number; rw: number; rx: number; ry: number; rz: number }; physicsState?: number;
    } | null;
    if (!ac?.position || ((ac.physicsState ?? 0) & 0x4)) continue; // open (Ethereal)
    const p = ac.position;
    // The door's local +Y (its forward) in AC landblock axes.
    const fx = 2 * (p.rx * p.ry - p.rw * p.rz), fy = 1 - 2 * (p.rx * p.rx + p.rz * p.rz);
    const beats: Record<string, unknown>[] = [];
    for (const side of [1, -1]) {
      for (const phase of ['closed', 'opened'] as const) {
        // 'closed' waits for the door to be shut (ACE re-closes it on a timer); 'opened' Uses it.
        if (phase === 'closed') {
          for (let i = 0; i < 30; i++) {
            const s0 = await page.evaluate(`window.acDebug.objectAcPosition(${door.guid})`) as { physicsState?: number };
            if (!((s0?.physicsState ?? 0) & 0x4)) break;
            await page.waitForTimeout(1000);
          }
        } else {
          await page.evaluate(`window.acDebug.useObject(${door.guid})`);
          await page.waitForTimeout(4000);
        }
        const sx = p.x + side * fx * 3, sy = p.y + side * fy * 3;
        // Face the door: heading θ about Z with forward (−sinθ, cosθ) = −side·f.
        const th = Math.atan2(side * fx, -side * fy);
        const cell = ((p.landblock & 0xffff0000) >>> 0) + (Math.floor(sx / 24) * 8 + Math.floor(sy / 24) + 1);
        await teleloc(page, `0x${cell.toString(16).padStart(8, '0')} [${sx.toFixed(2)} ${sy.toFixed(2)} ${(p.z + 0.1).toFixed(2)}] ${Math.cos(th / 2).toFixed(4)} 0 0 ${Math.sin(th / 2).toFixed(4)}`, 8000);
        const st = await page.evaluate(`window.acDebug.objectAcPosition(${door.guid})`) as { physicsState?: number };
        const a = await collisionState(page);
        await page.keyboard.down('w');
        await page.waitForTimeout(3000);
        await page.keyboard.up('w');
        await page.waitForTimeout(600);
        const b = await collisionState(page);
        // Signed distance along the door's forward, in THREE world (x = AC x, z = AC y).
        const lbx = ((p.landblock >>> 24) & 0xff) * 192, lby = ((p.landblock >>> 16) & 0xff) * 192;
        const along = (q: { x: number; z: number }) => (q.x - (lbx + p.x)) * fx + (q.z - (lby + p.y)) * fy;
        const beat = { side, step: phase, doorOpen: ((st?.physicsState ?? 0) & 0x4) !== 0, doorState: st?.physicsState, start: along(a), end: along(b), crossed: Math.sign(along(a)) !== Math.sign(along(b)), moved: Math.hypot(b.x - a.x, b.z - a.z) };
        beats.push(beat);
        await page.screenshot({ path: join(OUT, `door-${side > 0 ? 'front' : 'back'}-${beat.doorOpen ? 'open' : 'closed'}.png`) });
        console.log(JSON.stringify(beat));
      }
    }
    report.door = { guid: door.guid, name: door.name, position: p, beats };
    done = true;
    break;
  }
  if (!done) report.error = 'no closed door found near Holtburg';
} finally {
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
