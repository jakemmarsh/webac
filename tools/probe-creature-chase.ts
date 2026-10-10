/**
 * probe-creature-chase — does an aggroed creature visibly chase us?
 *
 * The admin session (testacjs2) brings a plain character (AC_OBSERVER,
 * default testacjs3 / Obsprobe) to it and spawns an aggressive Drudge
 * Skulker (wcid 7) beside it; the plain character runs away while its page
 * records the drudge: the MoveTo events it gets, the drawn position, the
 * cycle, and the distance to us. Then the admin smites it.
 *
 * Usage: npx tsx tools/probe-creature-chase.ts
 */
import { enterWorld, adminCommand, shot, gameUrl } from './lib/game-session.js';
const OUT = 'verification/creature-chase';
const OBS = process.env.AC_OBSERVER ?? 'testacjs3';
/** The admin account: testacjs (access level 5) in the cloud; testacjs2 on Jake's Mac. */
const ADMIN = process.env.AC_ADMIN ?? (process.platform === 'darwin' ? 'testacjs2' : 'testacjs');

async function main(): Promise<void> {
  const admin = await enterWorld({ createCharacter: 'Chaseadmin', url: gameUrl({ cb: 'chase-admin', env: { ...process.env, AC_ACCOUNT: ADMIN, AC_PASSWORD: ADMIN } }) } as never);
  console.log('admin in world');
  await admin.page.waitForTimeout(3000);
  await adminCommand(admin.page, `@teleloc ${process.env.CHASE_LOC ?? '0xA9B40019 [85.0 20.5 94.0] 1 0 0 0'}`);
  await admin.page.waitForTimeout(6000);
  // Cloaked, the admin is not a target: the drudge has to pick the prey.
  await adminCommand(admin.page, '@cloak on');
  await admin.page.waitForTimeout(1500);
  const prey = await enterWorld({ createCharacter: 'Obsprobe', url: gameUrl({ cb: 'chase-prey', env: { ...process.env, AC_ACCOUNT: OBS, AC_PASSWORD: OBS } }) } as never);
  console.log('prey in world');
  await prey.page.waitForTimeout(3000);
  await adminCommand(admin.page, '@teletome Obsprobe');
  await prey.page.waitForTimeout(9000);
  await prey.page.evaluate(`(() => {
    const som = window.__ac.serverObjectManager;
    const rec = window.__ch = { ev: [], tl: [], t0: performance.now() };
    const t = () => Math.round(performance.now() - rec.t0);
    const orig = som.applyParsedMotion.bind(som);
    som.applyParsedMotion = (g, a, p) => { const o = som.objects.get(g); if (o && /drudge/i.test(o.name || '')) rec.ev.push({ t: t(), g: g.toString(16), type: p.movementType, fwd: p.forwardCommand.toString(16), mt: p.moveTo ? { tgt: p.moveTo.target.toString(16), run: +p.moveTo.runRate.toFixed(2), d: +p.moveTo.distanceToObject.toFixed(2) } : null }); return orig(g, a, p); };
    setInterval(() => { const cs = window.acDebug.collisionState();
      // The nearest drudge: the spawn we made, not a native one further off.
      const dist = (o) => Math.hypot(o.worldX - cs.x, o.worldZ - cs.z);
      const d = [...som.objects.values()].filter((o) => /drudge/i.test(o.name || '') && o.collisionRadius > 0).sort((a, b) => dist(a) - dist(b))[0];
      if (!d) return; const an = som.getAnimated(d.guid);
      const mt = d.moveTo; const node = mt && mt.pending[0];
      const bearing = Math.atan2(cs.x - d.worldX, cs.z - d.worldZ) * 180 / Math.PI;
      rec.tl.push({ t: t(), g: d.guid.toString(16), d: +Math.hypot(d.worldX - cs.x, d.worldZ - cs.z).toFixed(2), mv: !!(mt && mt.isMovingTo()),
        node: node ? (node.type === 9 ? 'turn' : 'move') : '-', cmd: mt ? (mt.currentCommand & 0xffff).toString(16) : '-',
        hd: +(d.physics ? d.physics.heading : 0).toFixed(0), br: +bearing.toFixed(0),
        cyc: an ? (an.motionManager.motion & 0xffff).toString(16) : '-' }); }, 250);
  })()`);
  // Dismiss the new-character welcome box (it eats the movement keys), then
  // run ~15 m away from the admin before the drudge exists, so it has to chase.
  await prey.page.mouse.click(783, 432);
  await prey.page.waitForTimeout(500);
  await prey.page.mouse.click(780, 600);
  await prey.page.keyboard.down('w'); await prey.page.waitForTimeout(3500); await prey.page.keyboard.up('w');
  await prey.page.waitForTimeout(1500);
  await adminCommand(admin.page, '@create 7');
  await prey.page.waitForTimeout(1500);
  await shot(prey.page, `${OUT}/1-spawned.png`);
  await prey.page.waitForTimeout(1500);
  await shot(prey.page, `${OUT}/2-chasing.png`);
  await prey.page.waitForTimeout(3000);
  await shot(prey.page, `${OUT}/3-caught-up.png`);
  const rec = JSON.parse(await prey.page.evaluate('JSON.stringify(window.__ch)') as string);
  console.log('events', JSON.stringify(rec.ev));
  console.log('timeline', rec.tl.map((r: { t: number; g: string; d: number; mv: boolean; node: string; cmd: string; hd: number; br: number; cyc: string }) => `${r.t}:${r.g} d=${r.d} ${r.mv ? r.node : '-'} cmd=${r.cmd} c=${r.cyc} hd=${r.hd} br=${r.br}`).join(' | '));
  await adminCommand(admin.page, '@smite all');
  await admin.page.waitForTimeout(2000);
  await prey.browser.close();
  await admin.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
