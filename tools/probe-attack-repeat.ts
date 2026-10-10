/**
 * probe-attack-repeat — BUG.combat-attack-charge-build.b live check: with
 * Repeat Attacks on, one charged End press sends the bar's power and then
 * the slider's (EndAttackRequest), and every later swing is the server's
 * (ACE Player_Melee repeat after AttackDone(0)) with NO client re-send.
 * Moving the power slider mid-repeat re-sends exactly once at the new power
 * (HandleAttackDoneEvent @ 0056c500, |requested - slider| > 0.01).
 *
 * Usage: npx tsx tools/probe-attack-repeat.ts
 * Writes verification/attack-repeat/{state.json,console.log,*.png}. Soft-
 * deletes the probe character if it had to create one (auto-enter normally
 * resumes the account's existing character).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, adminCommand, openSession, gameUrl, waitForCharSelect, sessionArgs, REPO } from './lib/game-session.js';

const OUT = `${REPO}/verification/attack-repeat`;
const NAME = 'Repeatprobe';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ ...sessionArgs(), cb: 'attack-repeat', createCharacter: NAME } as never);
  const { page } = s;
  const log: { t: number; text: string }[] = [];
  const all: string[] = [];
  const t0 = Date.now();
  page.on('console', (m) => {
    const t = m.text();
    all.push(`${Date.now() - t0} ${t}`);
    if (/Sent TargetedMelee|\[AttackDone\]|\[CommenceAttack\]|\[meter\]/.test(t)) log.push({ t: Date.now() - t0, text: t });
  });
  // Server swings show up as our character's non-autonomous attack motions;
  // count them through the combat-text / AttackDone cadence instead.
  await page.waitForTimeout(4000);
  await page.mouse.click(700, 300);
  await adminCommand(page, '@god');
  await page.waitForTimeout(1500);
  // A Sparring Golem (wcid 12699) spawned in front, so the target is in
  // melee reach wherever auto-enter landed (a far golem behind walls makes
  // ACE cancel the approach with 0x36 before any repeat).
  await adminCommand(page, '@create 12699');
  await page.waitForTimeout(2500);
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(2500);
  const repeatOn = await page.evaluate('window.__ac.gameUI.optionsSettings.repeatAttacks');
  type Pick = { guid: number; name: string } | null;
  const find = (): Promise<Pick> => page.evaluate(`(() => {
    let best = null, bestD = 1e9; const me = window.acDebug.collisionState();
    for (const o of window.acDebug.getObjects()) {
      if (!/Sparring Golem|Drudge/.test(o.name)) continue;
      const p = window.acDebug.screenPosOf(o.guid);
      if (!p || p.x < 100 || p.x > innerWidth - 100 || p.y < 100 || p.y > innerHeight - 150) continue;
      const d = Math.hypot((o.worldX ?? 0) - me.x, (o.worldZ ?? 0) - me.z);
      if (d < bestD) { bestD = d; best = { guid: o.guid, name: o.name }; }
    }
    return best; })()`) as Promise<Pick>;
  let pick = await find();
  for (let i = 0; i < 16 && !pick; i++) {
    await page.keyboard.down('KeyA'); await page.waitForTimeout(350); await page.keyboard.up('KeyA');
    await page.waitForTimeout(400);
    pick = await find();
  }
  if (!pick) throw new Error('no attackable creature on screen');
  await page.evaluate(`window.acDebug.select(${pick.guid})`);
  await page.waitForTimeout(800);
  const target = await page.evaluate('window.acDebug.getTarget()');
  console.log(`target ${pick.name} 0x${pick.guid.toString(16)} selected=${target === pick.guid} repeatAttacks=${repeatOn}`);

  // Slider at 0.5, hold End 1.2 s (full bar), release.
  await page.evaluate('window.__ac.gameUI.combatPowerLevel = 0.5');
  const mark0 = log.length;
  // BUG.combat-attack-charge-build.c.a: sample the meter every 100 ms so the
  // hold between CommenceAttack and AttackDone shows in the log.
  await page.evaluate(`window.__meterProbe = setInterval(() => console.log('[meter] ' + window.__ac.gameUI.getCombatPowerBarLevel().toFixed(3)), 100)`);
  await page.keyboard.down('End');
  await page.waitForTimeout(1200);
  await page.keyboard.up('End');
  await page.waitForTimeout(7000);
  await page.screenshot({ path: join(OUT, 'repeating.png') });
  await page.evaluate('clearInterval(window.__meterProbe)');
  const phase1 = log.slice(mark0);

  // Move the slider mid-repeat: one re-send at 0.9 expected.
  const mark1 = log.length;
  await page.evaluate('window.__ac.gameUI.combatPowerLevel = 0.9');
  await page.waitForTimeout(6000);
  const phase2 = log.slice(mark1);

  // Leave combat: the chain ends.
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(3000);
  // Meter levels inside each CommenceAttack → AttackDone window: retail
  // HandleCommenceAttackEvent @ 0056ad20 holds them at the swing's power.
  const swingWindows: number[][] = [];
  let cur: number[] | null = null;
  for (const l of phase1) {
    if (/\[CommenceAttack\]/.test(l.text)) cur = [];
    else if (/\[AttackDone\]/.test(l.text)) { if (cur) swingWindows.push(cur); cur = null; }
    else if (cur && /\[meter\]/.test(l.text)) cur.push(Number(l.text.split(' ')[1]));
  }
  const sends1 = phase1.filter((l) => /Sent TargetedMelee/.test(l.text));
  const dones1 = phase1.filter((l) => /\[AttackDone\] errorType=0x0\b/.test(l.text));
  const sends2 = phase2.filter((l) => /Sent TargetedMelee/.test(l.text));
  const dones2 = phase2.filter((l) => /\[AttackDone\] errorType=0x0\b/.test(l.text));
  const result = {
    target: pick, selected: target === pick.guid, repeatAttacks: repeatOn,
    phase1: { sends: sends1.map((l) => l.text), repeatAttackDones: dones1.length, swingWindows },
    phase2: { sends: sends2.map((l) => l.text), repeatAttackDones: dones2.length },
    log,
  };
  writeFileSync(join(OUT, 'state.json'), JSON.stringify({ ...result, log: log.filter((l) => !/\[meter\]/.test(l.text)) }, null, 2));
  writeFileSync(join(OUT, 'console.log'), all.join('\n'));
  console.log(`RESULT phase1 sends=${sends1.length} [${sends1.map((l) => l.text.match(/power=([\d.]+)/)?.[1]).join(', ')}] server-repeats=${dones1.length}`);
  console.log(`RESULT swing-window meters ${swingWindows.map((w) => `[${[...new Set(w)].join(',')}]`).join(' ')}`);
  console.log(`RESULT phase2 sends=${sends2.length} [${sends2.map((l) => l.text.match(/power=([\d.]+)/)?.[1]).join(', ')}] server-repeats=${dones2.length}`);
  await adminCommand(page, '@ungod');
  await page.waitForTimeout(1000);
  await s.browser.close();

  // Soft-delete the probe character so auto-enter keeps landing elsewhere.
  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'attack-repeat-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.selectScreen.characters.find((s) => s.name === ${JSON.stringify('+' + NAME)} || s.name === ${JSON.stringify(NAME)});
    return c ? ui.callbacks.onDeleteCharacter(c) : false; })()`);
  await s2.page.waitForTimeout(3000);
  console.log('probe character deleted:', del);
  await s2.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
