/**
 * probe-auto-target — BUG.combat-attack-charge-build.c live check of retail
 * Auto Target (ClientCombatSystem::RecvNotice_SelectionChanged @ 0056bd80 →
 * AutoTarget @ 0056bc80): in melee mode with Auto Target on, killing the
 * selected creature (@smite) selects the nearest attackable compass item
 * (CPlayerSystem::SelectNext) and sends NO attack; an Escape deselect
 * (targetWillinglyLost) selects nothing.
 *
 * Usage: npx tsx tools/probe-auto-target.ts
 * Writes verification/auto-target/{state.json,console.log,*.png}. Soft-deletes
 * the probe character it creates.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enterWorld, adminCommand, openSession, gameUrl, waitForCharSelect, sessionArgs, REPO } from './lib/game-session.js';

const OUT = `${REPO}/verification/auto-target`;
const NAME = 'Autotargetprobe';

type Cand = { guid: number; name: string; d: number };

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ ...sessionArgs(), cb: 'auto-target', createCharacter: NAME } as never);
  const { page } = s;
  const all: string[] = [];
  const t0 = Date.now();
  page.on('console', (m) => all.push(`${Date.now() - t0} ${m.text()}`));
  await page.waitForTimeout(4000);
  await page.mouse.click(700, 300);
  await adminCommand(page, '@god');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Backquote');
  await page.waitForTimeout(2500);
  const autoTargetOn = await page.evaluate('window.__ac.gameUI.optionsSettings.autoTarget');

  // Attackable creatures by retail SelectNext weight (2-D + 1.2 |dz|), nearest first.
  const ranked = (): Promise<Cand[]> => page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    const out = [];
    for (const o of window.__ac.serverObjectManager.getAllObjects().values()) {
      if (!o.mesh || (o.itemType & 0x10) === 0 || (o.objectDescFlags & 0x10) === 0 || (o.objectDescFlags & 0x8)) continue;
      if (window.__ac.serverObjectManager.isDying(o.guid)) continue;
      const flat = Math.hypot(o.worldX - me.x, o.worldZ - me.z);
      if (flat > 75) continue;
      out.push({ guid: o.guid, name: o.name, d: flat + Math.abs(o.worldY - me.y) * 1.2 });
    }
    return out.sort((a, b) => a.d - b.d || a.guid - b.guid); })()`) as Promise<Cand[]>;

  // Two non-aggro Drudge Skulkers (wcid 19257) in front of us: the start
  // point is indoors (radar radius 25 m), so the academy's golems are out
  // of SelectNext's range.
  await adminCommand(page, '@create 19257');
  await page.waitForTimeout(1500);
  await page.keyboard.down('KeyA'); await page.waitForTimeout(400); await page.keyboard.up('KeyA');
  await adminCommand(page, '@create 19257');
  await page.waitForTimeout(3000);
  const list = await ranked();
  console.log('candidates', JSON.stringify(list.slice(0, 5)));
  if (list.length < 2) throw new Error(`need 2 attackable creatures in radar range, found ${list.length}`);

  // 1. Kill the selected creature: Auto Target picks the next, no swing.
  const victim = list[0];
  await page.evaluate(`window.acDebug.select(${victim.guid})`);
  await page.waitForTimeout(1500);
  const mark = all.length;
  await adminCommand(page, '@smite');
  let after = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    after = (await page.evaluate('window.acDebug.getTarget() ?? 0')) as number;
    if (after !== 0 && after !== victim.guid) break;
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, 'after-kill.png') });
  const expected = (await ranked()).filter((c) => c.guid !== victim.guid)[0] ?? null;
  const attacksAfterKill = all.slice(mark).filter((l) => /Sent TargetedMelee|TargetedMeleeAttack/.test(l));

  // 2. Escape deselect (targetWillinglyLost): nothing is auto-selected.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);
  const afterEscape = (await page.evaluate('window.acDebug.getTarget() ?? 0')) as number;
  await page.screenshot({ path: join(OUT, 'after-escape.png') });

  const result = {
    autoTargetOn,
    victim,
    selectedAfterKill: after,
    expectedNearest: expected,
    matchesNearest: expected ? after === expected.guid : false,
    attacksSentAfterKill: attacksAfterKill,
    selectedAfterEscape: afterEscape,
  };
  writeFileSync(join(OUT, 'state.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(OUT, 'console.log'), all.join('\n'));
  console.log(`RESULT autoTarget=${autoTargetOn} killed ${victim.name} 0x${victim.guid.toString(16)} → selected 0x${after.toString(16)} (expected ${expected?.name} 0x${expected?.guid.toString(16)}) attacksSent=${attacksAfterKill.length} afterEscape=0x${afterEscape.toString(16)}`);

  // Clean up the spawned drudges (@smite all: every creature in radar range).
  await adminCommand(page, '@smite all');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Backquote');
  await adminCommand(page, '@ungod');
  await page.waitForTimeout(1000);
  await s.browser.close();

  const s2 = await openSession({ ...sessionArgs(), viewport: { width: 1280, height: 800 } });
  await s2.page.goto(gameUrl({ autoenter: false, cb: 'auto-target-cleanup' }), { waitUntil: 'domcontentloaded' });
  await waitForCharSelect(s2.page, { timeoutMs: 240_000, pollMs: 1000, reloadEveryMs: 0 });
  await s2.page.waitForTimeout(2000);
  console.log('characters', await s2.page.evaluate('JSON.stringify(window.__ac.gameUI.selectScreen.characters.map((c) => c.name))'));
  const del = await s2.page.evaluate(`(() => { const ui = window.__ac.gameUI; const c = ui.selectScreen.characters.find((s) => s.name === ${JSON.stringify('+' + NAME)} || s.name === ${JSON.stringify(NAME)});
    return c ? ui.callbacks.onDeleteCharacter(c) : false; })()`);
  await s2.page.waitForTimeout(3000);
  console.log('probe character deleted:', del);
  await s2.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
