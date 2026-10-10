/**
 * probe-combat-motion — what the server sends for OUR character's motion
 * during a melee attack and while eating, and what our animation does with it.
 *
 * Records, in the page:
 *  - every MovementEvent (0xF74C) for our guid, as parsed (movement type,
 *    style, forward command, the one-shot actions);
 *  - every action queued on our MotionManager (and whether a clip exists for it);
 *  - a timeline of position, forward motion and isPlayingAction.
 * Then spawns a non-aggressive drudge (wcid 19257), attacks it in melee, and
 * eats an apple (wcid 258).
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-combat-motion.ts
 */
import { enterWorld, adminCommand, shot } from './lib/game-session.js';
const OUT = 'verification/combat-motion';

const HOOK = `(() => {
  const ac = window.__ac, som = ac.serverObjectManager, me = ac.charGuid;
  const rec = window.__probe = { events: [], queued: [], timeline: [], t0: performance.now() };
  const t = () => Math.round(performance.now() - rec.t0);
  const origApply = som.applyParsedMotion.bind(som);
  som.applyParsedMotion = (guid, animated, parsed) => {
    if (guid === me) rec.events.push({ t: t(), type: parsed.movementType, style: parsed.styleIndex.toString(16),
      fwd: parsed.forwardCommand.toString(16), actions: parsed.actions.map((a) => a.command.toString(16) + '@' + a.speed.toFixed(2)) });
    return origApply(guid, animated, parsed);
  };
  const mm = som.animatedObjects.get(me).motionManager;
  const origQ = mm.queueAction.bind(mm);
  mm.queueAction = (id, speed, cb) => {
    let has = null;
    try { has = typeof mm.hasMotion === 'function' ? mm.hasMotion(id) : null; } catch {}
    rec.queued.push({ t: t(), id: (id >>> 0).toString(16), speed, has, stack: (new Error().stack || '').split('\\n')[2]?.trim().slice(0, 80) });
    return origQ(id, speed, cb);
  };
  setInterval(() => {
    const cs = window.acDebug.collisionState();
    rec.timeline.push({ t: t(), x: +cs.x.toFixed(2), z: +cs.z.toFixed(2), playing: mm.isPlayingAction,
      fwd: (mm.currentForwardMotion ?? mm.forwardMotionId ?? mm.currentMotion ?? 0).toString(16) });
  }, 200);
  return Object.keys(mm).join(',');
})()`;

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'combat-motion' } as never);
  const logs: string[] = [];
  s.page.on('console', (m) => { const x = m.text(); if (/Melee|Attack|approach|Eat|UseDone|Sent Use|damage|hit|PScript/i.test(x)) logs.push(x.slice(0, 160)); });
  await s.page.waitForTimeout(4000);
  console.log('mm keys:', await s.page.evaluate(HOOK));
  // God mode first: its skills make the swings land (the hit Splatter* PlayScript).
  await adminCommand(s.page, '@god');
  await s.page.waitForTimeout(1500);
  // A drudge that won't fight back, in front of us.
  await adminCommand(s.page, '@create 19257');
  await s.page.waitForTimeout(3000);
  const drudge = await s.page.evaluate(`(() => { const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => /drudge/i.test(o.name || '')).pop(); return o ? o.guid : 0; })()`) as number;
  console.log('drudge', drudge.toString(16));
  // A melee weapon (ACE reverts Melee to NonCombat while a wand is wielded).
  await s.page.evaluate(`window.acDebug.unwield('Held')`);
  await s.page.waitForTimeout(2500);
  await s.page.evaluate(`window.acDebug.equip('Rusted Dirk')`);
  await s.page.waitForTimeout(3000);
  console.log('equipped:', JSON.stringify(await s.page.evaluate('window.acDebug.equipped()')));
  // Stand 8 m off so the attack needs the server's MoveToObject.
  const dpos = await s.page.evaluate(`(() => { const o = window.__ac.serverObjectManager.getObject(${drudge}); return o && o.position ? o.position : null; })()`) as { landblock?: number; x?: number; y?: number; z?: number } | null;
  console.log('drudge pos', JSON.stringify(dpos));
  await adminCommand(s.page, '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0');
  await s.page.waitForTimeout(8000);
  await s.page.evaluate(`window.acDebug.select(${drudge})`);
  await s.page.evaluate(`window.acDebug.combatMode('melee')`);
  await s.page.waitForTimeout(2500);
  await s.page.evaluate(`window.acDebug.attack(${drudge})`);
  await s.page.waitForTimeout(700);
  await shot(s.page, `${OUT}/1-running-to-target.png`);
  await s.page.waitForTimeout(1500);
  await shot(s.page, `${OUT}/2-swing.png`);
  await s.page.waitForTimeout(6800);
  const combat = await s.page.evaluate('JSON.stringify(window.__probe)') as string;
  console.log('=== COMBAT');
  const c = JSON.parse(combat);
  console.log('events', JSON.stringify(c.events));
  console.log('queued', JSON.stringify(c.queued));
  console.log('timeline', c.timeline.map((r: { t: number; x: number; z: number; playing: boolean; fwd: string }) => `${r.t}:${r.x},${r.z}:${r.playing ? 'A' : '-'}:${r.fwd}`).join(' '));
  console.log('logs', logs.join(' || '));
  // Casting: what does the server send for our own character?
  await s.page.evaluate(`window.acDebug.unwield('MeleeWeapon')`);
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`window.acDebug.equip('Practice Wand')`);
  await s.page.waitForTimeout(2500);
  await s.page.evaluate(`window.acDebug.combatMode('magic')`);
  await s.page.waitForTimeout(2500);
  // Flame Bolt I (spell 27): teach it, and give the mana to cast it.
  const spell = await s.page.evaluate(`(() => { for (const [id, sp] of window.__ac.spellTable.spells) if (sp.name === 'Flame Bolt VI') return id; return 27; })()`) as number;
  await adminCommand(s.page, `@addspell ${spell}`);
  await adminCommand(s.page, '@god');
  await s.page.waitForTimeout(3000);
  console.log('spell', spell);
  await s.page.evaluate(`window.__probe.events = []; window.__probe.queued = []; window.__probe.t0 = performance.now()`);
  await s.page.evaluate(`window.__ac.castSpell(${spell}, ${drudge})`);
  await s.page.waitForTimeout(900);
  await shot(s.page, `${OUT}/3-cast-windup.png`);
  await s.page.waitForTimeout(5100);
  const cast = JSON.parse(await s.page.evaluate('JSON.stringify(window.__probe)') as string);
  console.log('=== CAST');
  console.log('events', JSON.stringify(cast.events));
  console.log('queued', JSON.stringify(cast.queued.map((q: { t: number; id: string; stack: string }) => [q.t, q.id, q.stack.replace(/\(.*/, '')])));
  // Eating.
  await s.page.evaluate(`window.acDebug.combatMode('peace')`);
  await s.page.waitForTimeout(2500);
  await adminCommand(s.page, '@ci 258');
  await s.page.waitForTimeout(2500);
  await s.page.evaluate(`window.__probe.events = []; window.__probe.queued = []; window.__probe.timeline = []; window.__probe.t0 = performance.now()`);
  const apple = await s.page.evaluate(`(() => { const it = (window.__ac.gameUI.inventoryItems || []).find((i) => /apple/i.test(i.name || '')); return it ? (it.guid ?? it.id) : 0; })()`) as number;
  console.log('apple', apple.toString(16));
  logs.length = 0;
  s.page.on('console', (m) => { const x = m.text(); if (/Use|apple|Apple|eat/i.test(x)) logs.push('USE ' + x.slice(0, 160)); });
  // The pack double-click (dragCallbacks.onDoubleClickItem → Use), by the apple's index.
  await s.page.evaluate(`(() => { const ui = window.__ac.gameUI; const idx = window.__ac.playerState.inventory.getAll().findIndex((i) => i.id === ${apple}); ui.dragCallbacks.onDoubleClickItem(idx); })()`);
  await s.page.waitForTimeout(350);
  await shot(s.page, `${OUT}/4-eating.png`);
  await s.page.waitForTimeout(4650);
  const eat = JSON.parse(await s.page.evaluate('JSON.stringify(window.__probe)') as string);
  console.log('=== EAT');
  console.log('events', JSON.stringify(eat.events));
  console.log('queued', JSON.stringify(eat.queued));
  console.log('logs', logs.join(' || '));
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
