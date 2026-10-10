/**
 * probe-remote-player-anim — "other players aren't animated: TestPartner
 * casts and moves but just slides around".
 *
 * Two sessions: a mover (testacjs2 / +TestPartner) runs, turns and casts;
 * an observer (AC_OBSERVER account, default testacjs3, character created if
 * needed) records every MovementEvent it receives for the mover, the mover's
 * MotionManager state, and whether any part of the mover's mesh actually
 * changes pose frame to frame.
 *
 * Usage: npx tsx tools/probe-remote-player-anim.ts
 */
import { enterWorld, adminCommand, shot, gameUrl } from './lib/game-session.js';
const OUT = 'verification/remote-player-anim';
const OBS = process.env.AC_OBSERVER ?? 'testacjs3';

async function main(): Promise<void> {
  const mover = await enterWorld({ cb: 'rpa-mover', url: gameUrl({ cb: 'rpa-mover', env: { ...process.env, AC_ACCOUNT: 'testacjs2', AC_PASSWORD: 'testacjs2' } }) } as never);
  await mover.page.waitForTimeout(3000);
  await adminCommand(mover.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await mover.page.waitForTimeout(6000);
  const observer = await enterWorld({ cb: 'rpa-observer', createCharacter: 'Obsprobe', url: gameUrl({ cb: 'rpa-observer', env: { ...process.env, AC_ACCOUNT: OBS, AC_PASSWORD: OBS } }) } as never);
  await observer.page.waitForTimeout(4000);
  const moverGuid = await mover.page.evaluate('window.__ac.charGuid') as number;
  const moverName = await mover.page.evaluate(`window.__ac.serverObjectManager ? (window.__ac.playerName || '') : ''`);
  console.log('mover', moverGuid.toString(16), moverName);
  // Bring the observer next to the mover (a @teleto from the mover's admin).
  const obsName = await observer.page.evaluate(`(() => { const s = document.body.innerText.match(/\\+?Obsprobe/); return 'Obsprobe'; })()`);
  await adminCommand(mover.page, `@teletome ${obsName}`);
  await observer.page.waitForTimeout(10000);
  const hook = await observer.page.evaluate(`(() => {
    const som = window.__ac.serverObjectManager, g = ${moverGuid};
    const rec = window.__rpa = { ev: [], tl: [], rebuilds: 0, t0: performance.now() };
    const origUA = som.updateAppearance.bind(som);
    som.updateAppearance = (d) => { if (d.guid === g) rec.rebuilds++; return origUA(d); };
    const t = () => Math.round(performance.now() - rec.t0);
    const orig = som.applyParsedMotion.bind(som);
    som.applyParsedMotion = (guid, a, p) => { if (guid === g) rec.ev.push({ t: t(), type: p.movementType, auto: p.autonomous, style: p.styleIndex.toString(16), fwd: p.forwardCommand.toString(16), fs: +(p.forwardSpeed || 0).toFixed(2), turn: p.turnCommand.toString(16), actions: p.actions.map((x) => x.command.toString(16)) }); return orig(guid, a, p); };
    const obj = som.objects.get(g), an = som.animatedObjects.get(g);
    let prev = null;
    setInterval(() => {
      const o = som.objects.get(g), a = som.animatedObjects.get(g);
      if (!o || !o.mesh) { rec.tl.push({ t: t(), missing: true }); return; }
      const qs = o.mesh.children.filter((c) => /^part_\\d+$/.test(c.name)).map((c) => c.quaternion.x + c.quaternion.y * 3 + c.quaternion.z * 5 + c.position.y * 7);
      const sig = qs.reduce((s, v) => s + v, 0);
      rec.tl.push({ t: t(), bound: a ? a.group === o.mesh : null, x: +o.worldX.toFixed(2), z: +o.worldZ.toFixed(2), anim: !!a, mm: a ? (a.motionManager.currentMotionId ?? a.motionManager.motion ?? 0).toString(16) : '-', action: a ? a.motionManager.isPlayingAction : null, poseDelta: prev === null ? 0 : +Math.abs(sig - prev).toFixed(4) });
      prev = sig;
    }, 200);
    return { found: !!obj, animated: !!an, mt: obj ? (obj.motionTableId || 0).toString(16) : null, setup: obj ? obj.setupId.toString(16) : null, mmKeys: an ? Object.keys(an.motionManager).slice(0, 40).join(',') : null };
  })()`);
  console.log('observer sees mover:', JSON.stringify(hook));
  // Mover: change appearance first (a wield swap → ObjDescEvent → the
  // observer rebuilds the mover's mesh), the case that lost the animation.
  await mover.page.evaluate(`window.acDebug.unwield('Held')`);
  await mover.page.waitForTimeout(2000);
  await mover.page.evaluate(`window.acDebug.equip('Rusted Dirk')`);
  await mover.page.waitForTimeout(2500);
  await mover.page.evaluate(`window.acDebug.unwield('MeleeWeapon')`);
  await mover.page.waitForTimeout(2000);
  await mover.page.evaluate(`window.acDebug.equip('Practice Wand')`);
  await mover.page.waitForTimeout(2500);
  // Mover: run forward 3 s, turn, stop.
  await mover.page.mouse.click(780, 300);
  await mover.page.keyboard.down('w'); await mover.page.waitForTimeout(3000); await mover.page.keyboard.up('w');
  await mover.page.waitForTimeout(1000);
  await mover.page.keyboard.down('a'); await mover.page.waitForTimeout(1500); await mover.page.keyboard.up('a');
  await mover.page.waitForTimeout(1500);
  await observer.page.waitForTimeout(200);
  await shot(observer.page, `${OUT}/observer.png`);
  // Mover: cast at itself (magic mode, a self buff).
  await mover.page.evaluate(`window.acDebug.combatMode('magic')`);
  await mover.page.waitForTimeout(3000);
  const spell = await mover.page.evaluate(`(() => { for (const [id, sp] of window.__ac.spellTable.spells) if (sp.name === 'Strength Other I' || sp.name === 'Strength Self I') return id; return 0; })()`) as number;
  if (spell) { await adminCommand(mover.page, `@addspell ${spell}`); await mover.page.waitForTimeout(1500); await mover.page.evaluate(`window.__ac.castSpell(${spell}, ${moverGuid})`); }
  await mover.page.waitForTimeout(4000);
  await mover.page.evaluate(`window.acDebug.combatMode('peace')`);
  await mover.page.waitForTimeout(2500);
  const rec = JSON.parse(await observer.page.evaluate('JSON.stringify(window.__rpa)') as string);
  console.log('appearance rebuilds of the mover seen by the observer:', rec.rebuilds);
  console.log('events', JSON.stringify(rec.ev));
  console.log('timeline', rec.tl.map((r: Record<string, unknown>) => r.missing ? `${r.t}:missing` : `${r.t}:${r.x},${r.z} bound=${r.bound} mm=${r.mm} A=${r.action} Δ=${r.poseDelta}`).join(' | '));
  await observer.browser.close();
  await mover.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
