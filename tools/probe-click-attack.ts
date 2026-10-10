/**
 * probe-click-attack — BUG.combat-attack-charge-build.a live check: in melee
 * combat a click on a creature only selects it and a double-click neither
 * uses nor attacks it (retail ItemHolder::UseObject @ 0x00588a80); the attack
 * goes out only from the Low/Med/High press (End = Medium Attack).
 *
 * Usage: AC_ACCOUNT=testacjs2 AC_PASSWORD=testacjs2 npx tsx tools/probe-click-attack.ts
 * Writes verification/click-attack/*.png.
 */
import { mkdirSync } from 'node:fs';
import { enterWorld, adminCommand, REPO } from './lib/game-session.js';

const OUT = `${REPO}/verification/click-attack`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'click-attack', createCharacter: 'Clickprobe' } as never);
  const { page } = s;
  const sends: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/\[AC\] Sent (TargetedMelee|TargetedMissile|Use)/.test(t) || /Sent Use\b/.test(t)) sends.push(t); });
  await page.waitForTimeout(4000);
  await page.mouse.click(700, 300);
  await adminCommand(page, '@god');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(2500);
  await adminCommand(page, '@create 7');
  await page.waitForTimeout(4000);
  // A fresh character starts in the Training Academy beside Sparring Golems
  // (attackable creatures); elsewhere, the @create'd Drudge.
  await page.evaluate('window.__skip = []');
  const find = (): Promise<unknown> => page.evaluate(`(() => {
    for (const o of window.acDebug.getObjects()) {
      if (!/Drudge|Sparring Golem/.test(o.name) || window.__skip.includes(o.guid)) continue;
      const p = window.acDebug.screenPosOf(o.guid);
      if (p && p.x > 100 && p.x < innerWidth - 100 && p.y > 100 && p.y < innerHeight - 150) return { guid: o.guid, name: o.name, p };
    }
    return null; })()`);
  type Pick = { guid: number; name: string; p: { x: number; y: number } } | null;
  let pick = await find() as Pick;
  for (let i = 0; i < 16 && !pick; i++) {
    // Turn in place until one is in view.
    await page.keyboard.down('KeyA'); await page.waitForTimeout(350); await page.keyboard.up('KeyA');
    await page.waitForTimeout(400);
    pick = await find() as Pick;
  }
  if (!pick) throw new Error('no attackable creature on screen');
  let target: NonNullable<Pick> = pick;
  console.log(`target ${target.name} 0x${target.guid.toString(16)} at ${Math.round(target.p.x)},${Math.round(target.p.y)}`);
  const report = async (label: string): Promise<void> => {
    const st = await page.evaluate(`JSON.stringify({ combat: window.__ac.gameUI.hud.combatMode, target: window.acDebug.getTarget() })`);
    console.log(label.padEnd(18), st, `sends=${sends.length}`, sends.slice(-2).join(' | '));
  };
  await report('before');
  // The click must land on the creature itself (a sign can sit in front).
  for (let tries = 0; ; tries++) {
    await page.mouse.click(target.p.x, target.p.y);
    await page.waitForTimeout(1500);
    if (await page.evaluate('window.acDebug.getTarget()') === target.guid) break;
    if (tries > 8) throw new Error('never clicked a creature');
    await page.evaluate(`window.__skip.push(${target.guid})`);
    let next = await find() as Pick;
    for (let i = 0; i < 16 && !next; i++) {
      await page.keyboard.down('KeyA'); await page.waitForTimeout(350); await page.keyboard.up('KeyA');
      await page.waitForTimeout(400);
      next = await find() as Pick;
    }
    if (!next) throw new Error('no clickable creature');
    target = next;
    console.log(`retry on ${target.name} 0x${target.guid.toString(16)}`);
  }
  await report('after click');
  await page.screenshot({ path: `${OUT}/after-click.png` });
  const clickSends = sends.length;
  const p2 = await page.evaluate(`window.acDebug.screenPosOf(${target.guid})`) as { x: number; y: number } | null;
  if (p2) await page.mouse.dblclick(p2.x, p2.y);
  await page.waitForTimeout(1500);
  await report('after dblclick');
  const dblSends = sends.length - clickSends;
  await page.keyboard.down('End');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/end-held.png` });
  await page.keyboard.up('End');
  await page.waitForTimeout(1500);
  await report('after End press');
  await page.screenshot({ path: `${OUT}/after-end.png` });
  console.log(`RESULT click-sends=${clickSends} dblclick-sends=${dblSends} end-sends=${sends.length - clickSends - dblSends}`);
  await adminCommand(page, '@smite');
  await page.waitForTimeout(1000);
  await adminCommand(page, '@ungod');
  await page.waitForTimeout(1000);
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
