/**
 * probe-missile-stance — entering / leaving missile combat with a bow,
 * crossbow and atlatl: the style-change transition, the server's Reload →
 * Ready, and the ammo ParentEvent (ACE Creature_Combat.cs
 * HandleSwitchToMissileCombatMode → Creature_Missile.cs ReloadMissileAmmo).
 *
 * Records, IN the page every 30 ms: the player's MotionManager style /
 * substate / isChangingStyle / playing animation id + frame, and which
 * wielded children hang off the player mesh; plus every MovementEvent for
 * our guid. Screenshots a strip through each transition.
 *
 * Usage (own account, so it never hijacks a teammate's character —
 * auto-account creation makes it; give it admin once, see below):
 *   AC_ACCOUNT=bowprobe1 AC_PASSWORD=bowprobe1 npx tsx tools/probe-missile-stance.ts [bow|crossbow|atlatl ...]
 * First run creates the character; then, logged out:
 *   docker exec ace-db mysql -uroot -p… -e "update ace_auth.account set accessLevel=5 where accountName='bowprobe1'"
 */
import { enterWorld, adminCommand, shot } from './lib/game-session.js';

const OUT = 'verification/missile-stance';
const KITS: Record<string, { weapon: string; wcid: number; ammo?: { name: string; wcid: number } }> = {
  bow: { weapon: 'Longbow', wcid: 306, ammo: { name: 'Arrow', wcid: 300 } },
  crossbow: { weapon: 'Light Crossbow', wcid: 312, ammo: { name: 'Quarrel', wcid: 305 } },
  atlatl: { weapon: 'Atlatl', wcid: 12463, ammo: { name: 'Atlatl Dart', wcid: 12464 } },
  // A thrown weapon is its own ammo (wielded in the MissileWeapon slot).
  thrown: { weapon: 'Throwing Axe', wcid: 5552 },
  bownoammo: { weapon: 'Longbow', wcid: 306 },
};

const HOOK = `(() => {
  const ac = window.__ac, som = ac.serverObjectManager, me = ac.charGuid;
  const ent = som.animatedObjects.get(me);
  const mm = ent.motionManager;
  const ctl = ac.animController && (ac.animController.mm || ac.animController.motionManager);
  const rec = window.__probe = { sameMM: ctl === mm, events: [], logs: [], timeline: [], t0: performance.now() };
  const origLog = console.log;
  console.log = (...a) => { const x = a.map(String).join(' '); if (/ParentEvent|PickupEvent|ChangeCombatMode|Missile|Attack|equip|Wield|ammunition|CombatMode/i.test(x)) rec.logs.push(t() + 'ms ' + x.slice(0, 140)); return origLog(...a); };
  const t = () => Math.round(performance.now() - rec.t0);
  const origApply = som.applyParsedMotion.bind(som);
  som.applyParsedMotion = (guid, animated, parsed, live) => {
    if (guid === me) rec.events.push({ t: t(), type: parsed.movementType, style: parsed.styleIndex.toString(16),
      fwd: parsed.forwardCommand.toString(16), spd: +(parsed.forwardSpeed ?? 1).toFixed(2), auto: !!parsed.autonomous,
      actions: (parsed.actions || []).map((a) => a.command.toString(16)) });
    return origApply(guid, animated, parsed, live);
  };
  window.__probeReset = () => { rec.t0 = performance.now(); rec.events.length = 0; rec.timeline.length = 0; rec.logs.length = 0; };
  setInterval(() => {
    const p = mm.player, a = p && p.currentAnimation;
    const mesh = ac.playerModel;
    const kids = [];
    if (mesh) mesh.traverse((o) => { if (/^wielded_|ammo|held/i.test(o.name || '')) kids.push(o.name + (o.visible ? '' : '(hidden)')); });
    rec.timeline.push({ t: t(), style: (mm.currentStyleId >>> 0).toString(16), sub: (mm.stance & 0xffff).toString(16),
      chg: mm.isChangingStyle, act: mm.isPlayingAction, anim: a ? (a.id >>> 0).toString(16) : '-',
      f: p && typeof p.frameNumber === 'number' ? +p.frameNumber.toFixed(1) : (p && p['frameNumber'] !== undefined ? p['frameNumber'] : null),
      kids: kids.join(',') });
  }, 30);
  return { sameMM: rec.sameMM, keys: Object.keys(mm).slice(0, 40).join(',') };
})()`;

async function dismissPopups(page: import('playwright').Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const at = await page.evaluate(`(() => { const b = [...document.querySelectorAll('.ac-dialog-button')].find((e) => e.getBoundingClientRect().width > 0);
      if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`) as { x: number; y: number } | null;
    if (!at) return;
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(600);
  }
}

/** Collapse the 30 ms timeline to its distinct states. */
function runs(tl: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  let prev = '';
  for (const r of tl) {
    const key = `${r.style} sub=${r.sub} chg=${r.chg ? 1 : 0} act=${r.act ? 1 : 0} anim=${r.anim} kids=[${r.kids}]`;
    if (key !== prev) out.push(`${String(r.t).padStart(5)}ms f=${r.f}  ${key}`);
    prev = key;
  }
  return out;
}

async function main(): Promise<void> {
  const which = process.argv.slice(2).length ? process.argv.slice(2) : ['bow'];
  const s = await enterWorld({ cb: 'missile-stance', createCharacter: 'Bowprobe' } as never);
  await s.page.waitForTimeout(5000);
  await dismissPopups(s.page);
  // The target drudges fight back once shot; a 30-HP probe character dies mid-capture otherwise.
  await adminCommand(s.page, '@god');
  await s.page.waitForTimeout(1500);
  console.log('hook:', JSON.stringify(await s.page.evaluate(HOOK)));
  for (const kitName of which) {
    const kit = KITS[kitName];
    // Clear hands, spawn the kit, wield it.
    for (const slot of ['MissileWeapon', 'MeleeWeapon', 'Held', 'TwoHanded', 'Shield', 'MissileAmmo']) {
      await s.page.evaluate(`window.acDebug.unwield(${JSON.stringify(slot)})`);
      await s.page.waitForTimeout(600);
    }
    await adminCommand(s.page, `@ci ${kit.wcid}`);
    if (kit.ammo?.wcid) await adminCommand(s.page, `@ci ${kit.ammo.wcid} 50`);
    await s.page.waitForTimeout(3000);
    await s.page.evaluate(`window.acDebug.equip(${JSON.stringify(kit.weapon)})`);
    await s.page.waitForTimeout(2500);
    if (kit.ammo) await s.page.evaluate(`window.acDebug.equip(${JSON.stringify(kit.ammo.name)})`);
    await s.page.waitForTimeout(2500);
    await dismissPopups(s.page);
    // Side-on and pulled in, so the draw reads in the frame.
    await s.page.evaluate(`(() => { const c = window.__ac.cameraController; c.cameraYawOffset = -1.3; c.pitch = -0.1; })()`);
    await s.page.waitForTimeout(500);
    console.log(`\n=== ${kitName}: equipped`, JSON.stringify(await s.page.evaluate('window.acDebug.equipped()')));

    const steps: Array<[string, string]> = [['enter', `window.acDebug.combatMode('missile')`]];
    if (kit.ammo || kitName === 'thrown') steps.push(['shoot', `window.acDebug.attack(window.__probeTarget)`]);
    steps.push(['leave', `window.acDebug.combatMode('peace')`]);
    if (kitName === 'bow') steps.push(['reenter', `window.acDebug.combatMode('missile')`], ['swap-to-melee', `window.acDebug.wieldByName('Dagger')`], ['leave2', `window.acDebug.combatMode('peace')`]);
    for (const [label, js] of steps) {
      if (label === 'shoot') {
        await adminCommand(s.page, '@create 19257');
        await s.page.waitForTimeout(3000);
        await s.page.evaluate(`(() => { const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => /drudge/i.test(o.name || '')).pop(); window.__probeTarget = o ? o.guid : 0; if (o) window.acDebug.select(o.guid); })()`);
      }
      if (label === 'swap-to-melee') { await adminCommand(s.page, '@ci 314'); await s.page.waitForTimeout(2500); }
      await s.page.evaluate('window.__probeReset()');
      await s.page.evaluate(js);
      for (const ms of [150, 300, 450, 700, 1100]) {
        await s.page.waitForTimeout(150);
        await shot(s.page, `${OUT}/${kitName}-${label}-${String(ms).padStart(4, '0')}.png`);
      }
      await s.page.waitForTimeout(label === 'shoot' || label === 'swap-to-melee' ? 5000 : 3000);
      await shot(s.page, `${OUT}/${kitName}-${label}-end.png`);
      const rec = await s.page.evaluate('window.__probe ? JSON.parse(JSON.stringify(window.__probe)) : { events: [], logs: [], timeline: [] }') as { events: unknown[]; logs: string[]; timeline: Array<Record<string, unknown>> };
      console.log(`--- ${kitName} ${label} — movement events for us:`);
      for (const e of rec.events) console.log('   ', JSON.stringify(e));
      console.log(`--- ${kitName} ${label} — client log:`);
      for (const l of rec.logs) console.log('   ', l);
      console.log(`--- ${kitName} ${label} — motion timeline:`);
      for (const line of runs(rec.timeline)) console.log('   ', line);
    }
    await s.page.evaluate(`window.acDebug.combatMode('peace')`);
    await s.page.waitForTimeout(1500);
  }
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
