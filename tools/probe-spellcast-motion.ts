/**
 * probe-spellcast-motion — what the server sends for OUR character while it
 * casts, and which animation nodes our MotionManager plays for it
 * (BUG.spellcast-animations).
 *
 * Records, in the page:
 *  - every MovementEvent for our guid, as parsed (type, autonomous, style,
 *    forward command + speed);
 *  - every node put on our AnimationPlayer (animation id, frame range,
 *    framerate × speed) — the sequence retail's CSequence would hold;
 * then learns + casts a self spell with a windup (Heal Self VI, 1161) and a
 * bolt at a spawned drudge (Flame Bolt VI, 85) in magic combat mode, and
 * screencasts the Heal cast (frames named by ms + the node on the player).
 *
 * Usage (never on testacjs — Jake plays on it):
 *   AC_ACCOUNT=testacjs3 AC_PASSWORD=testacjs3 npx tsx tools/probe-spellcast-motion.ts
 *   AC_BASE=http://localhost:3043/ … to probe a worktree's own vite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand } from './lib/game-session.js';
const OUT = 'verification/spellcast-motion';

const HOOK = `(() => {
  const ac = window.__ac, som = ac.serverObjectManager, me = ac.charGuid;
  const rec = window.__probe = { events: [], plays: [], t0: performance.now() };
  const t = () => Math.round(performance.now() - rec.t0);
  const origApply = som.applyParsedMotion.bind(som);
  som.applyParsedMotion = (guid, animated, parsed, live) => {
    if (guid === me) rec.events.push({ t: t(), type: parsed.movementType, auto: parsed.autonomous, style: parsed.styleIndex.toString(16),
      fwd: parsed.forwardCommand.toString(16), speed: +(parsed.forwardSpeed ?? 1).toFixed(2) });
    return origApply(guid, animated, parsed, live);
  };
  const mm = som.animatedObjects.get(me).motionManager;
  const p = mm.animationPlayer, origPlay = p.play.bind(p);
  p.play = (a, low, high, rate, speed, looping, cb) => {
    // carry: the previous node's overshoot this node starts with
    // (update_internal's leftover) — its in-simulation start is t − carry.
    // cut: the previous one-shot node was still playing (replaced early).
    rec.plays.push({ t: t(), anim: a.id.toString(16), range: low + '..' + high, rate: +(rate * (speed ?? 1)).toFixed(1), loop: looping,
      carry: p.isPlaying ? 0 : Math.round(p.leftoverTime * 1000), cut: p.isPlaying && !p.looping && p.framerate * p.speed !== 0 });
    return origPlay(a, low, high, rate, speed, looping, cb);
  };
  return 'hooked';
})()`;

async function dump(page: import('playwright').Page, label: string): Promise<void> {
  type Play = { t: number; anim: string; range: string; rate: number; loop: boolean; carry: number; cut: boolean };
  const rec = JSON.parse(await page.evaluate('JSON.stringify(window.__probe)') as string) as
    { events: { t: number; type: number; auto: boolean; style: string; fwd: string; speed: number }[]; plays: Play[] };
  console.log(`=== ${label}`);
  for (const e of rec.events) console.log(`  ev  t=${e.t} type=${e.type} auto=${e.auto} style=${e.style} fwd=${e.fwd} @${e.speed}`);
  // Each node's simulated length = the next node's start − its own start
  // (both carry-corrected); compare with (high − low + 1) / |rate|.
  rec.plays.forEach((p, i) => {
    const next = rec.plays[i + 1];
    const len = next ? ` len=${(next.t - next.carry) - (p.t - p.carry)}ms` : '';
    const want = p.rate ? ` retail=${Math.round((+p.range.split('..')[1] - +p.range.split('..')[0] + 1) / Math.abs(p.rate) * 1000)}ms` : '';
    console.log(`  play t=${p.t} ${p.anim} ${p.range} x${p.rate}${p.loop ? ' loop' : ''} carry=${p.carry}${p.cut ? ' CUT' : ''}${len}${p.loop ? '' : want}`);
  });
  await page.evaluate('window.__probe.events = []; window.__probe.plays = []');
}

async function main(): Promise<void> {
  const s = await enterWorld({ cb: 'spellcast-motion' } as never);
  const logs: string[] = [];
  s.page.on('console', (m) => { const x = m.text(); if (/Cast|spell|fizzle|component|Motion\]/i.test(x)) logs.push(x.slice(0, 160)); });
  await s.page.waitForTimeout(4000);
  console.log(await s.page.evaluate(HOOK));
  await adminCommand(s.page, '@god');
  await s.page.waitForTimeout(1500);
  await adminCommand(s.page, '@addspell 1161');
  await adminCommand(s.page, '@addspell 85');
  await s.page.waitForTimeout(1500);
  // ACE reverts Magic to NonCombat without a caster (Player_Combat.cs:875).
  // The Practice Wand (wcid 4799) every new character starts with; @ci one
  // if this character has none.
  if (!(await s.page.evaluate(`JSON.stringify([...(window.acDebug.equipped() || [])])`) as string).includes('Practice Wand')) {
    await adminCommand(s.page, '@ci 4799');
    await s.page.waitForTimeout(2500);
  }
  await s.page.evaluate(`window.acDebug.equip('Practice Wand', 'Held')`);
  await s.page.waitForTimeout(3000);
  console.log('equipped:', JSON.stringify(await s.page.evaluate('window.acDebug.equipped().map((e) => e.name)')));
  await s.page.evaluate(`window.acDebug.combatMode('magic')`);
  await s.page.waitForTimeout(3500);
  await dump(s.page, 'enter magic stance');

  const me = await s.page.evaluate('window.__ac.charGuid') as number;
  // Screenshots stall the renderer (seconds each under the headless GPU),
  // which compresses the choreography; a CDP screencast streams frames
  // without stalling. Each saved frame is named by its ms since the cast and
  // the node on the player at that moment.
  const cdp = await s.page.context().newCDPSession(s.page);
  const frames: { ms: number; node: string; data: string }[] = [];
  const tCast = Date.now();
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
    const ms = Date.now() - tCast;
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
    void s.page.evaluate(`(() => { const p = window.__ac.serverObjectManager.animatedObjects.get(window.__ac.charGuid).motionManager.animationPlayer;
      return (p.currentAnimation ? p.currentAnimation.id.toString(16) : '-') + '@' + p.currentFrameIndex; })()`).then((node) => frames.push({ ms, node: node as string, data: f.data })).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 2 });
  await s.page.evaluate(`window.__ac.castSpell(1161, ${me})`);
  await s.page.waitForTimeout(5000);
  await cdp.send('Page.stopScreencast');
  mkdirSync(OUT, { recursive: true });
  for (const f of frames) writeFileSync(`${OUT}/heal-${String(f.ms).padStart(5, '0')}-${f.node}.jpg`, Buffer.from(f.data, 'base64'));
  console.log(`screencast: ${frames.length} frames → ${OUT}`);
  await dump(s.page, 'Heal Self VI');

  await adminCommand(s.page, '@create 19257');
  await s.page.waitForTimeout(3000);
  const drudge = await s.page.evaluate(`(() => { const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => /drudge/i.test(o.name || '')).pop(); return o ? o.guid : 0; })()`) as number;
  if (drudge) {
    await s.page.evaluate(`window.acDebug.select(${drudge})`);
    await s.page.evaluate(`window.__ac.castSpell(85, ${drudge})`);
    await s.page.waitForTimeout(7000);
    await dump(s.page, 'Flame Bolt VI');
  }
  console.log('=== console');
  for (const l of logs) console.log('  ' + l);
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
