/**
 * probe-decomp-chat — live checks for the 2026-09-30 DECOMP message-reaction
 * fixes (M1/M2/M3 combat lines, M5 transient notice, M6 no invented combat
 * refusal, M8 trade-closed notice, M10 chest open, M12 channel index). Logs
 * every GameUI.addSystemMessage call (text + chat type) on client A
 * (testacjs2); client B (testacjs3) is the trade partner. Real GPU.
 * Usage: npx tsx tools/probe-decomp-chat.ts
 */
import { enterWorld, adminCommand, gameUrl } from './lib/game-session.ts';
import type { Page, ConsoleMessage } from 'playwright';
const urlFor = (acct: string) => gameUrl({ cb: 'chat', env: { ...process.env, AC_ACCOUNT: acct, AC_PASSWORD: acct } });
async function settle(p: Page, cmd: string) { let done = false; const f = (m: ConsoleMessage) => { if (/Sent LoginComplete/.test(m.text())) done = true; }; p.on('console', f); await adminCommand(p, cmd); for (let i = 0; i < 90 && !done; i++) await p.waitForTimeout(500); p.off('console', f); await p.waitForTimeout(3000); }
const tapChat = (p: Page) => p.evaluate(`(() => { const g = window.__ac.gameUI; const o = g.addSystemMessage.bind(g); g.addSystemMessage = (text, color, type, w) => { console.log('CHATLINE type=' + (type ?? 'none') + ' ' + String(text).replace(/\\n/g, ' ').slice(0, 160)); return o(text, color, type, w); }; })()`);
const A = await enterWorld({ url: urlFor('testacjs2'), gpu: true }); const a = A.page;
const lines: string[] = []; const mark = (l: string) => lines.push('--- ' + l);
a.on('console', (m) => { const t = m.text(); if (t.startsWith('CHATLINE')) lines.push(t.slice(9)); });
await settle(a, '@telepoi Holtburg'); await tapChat(a);
const guidOf = async (re: string) => a.evaluate(`(window.acDebug.listServerObjects().filter(o => ${re}.test(o.name)).pop() || {}).guid || 0`) as Promise<number>;

mark('M1/M2/M3 melee a sewer rat to death');
for (const slot of ['MissileWeapon', 'MeleeWeapon', 'Held', 'TwoHanded']) { await a.evaluate(`window.acDebug.unwield('${slot}')`).catch(() => {}); await a.waitForTimeout(800); }
await adminCommand(a, '@ci 351'); await a.waitForTimeout(2000); await a.evaluate("window.acDebug.wieldByName('Long Sword')"); await a.waitForTimeout(2500);
await adminCommand(a, '@create 7106'); await a.waitForTimeout(2500);
const rat = await guidOf('/Rat/');
await a.evaluate("window.acDebug.combatMode('melee')"); await a.waitForTimeout(2500);
for (let i = 0; i < 40; i++) {
  const alive = await a.evaluate(`!!window.__ac.serverObjectManager.getObject(${rat}) && !window.__ac.serverObjectManager.isDying(${rat})`);
  if (!alive) break;
  await a.evaluate(`window.acDebug.selectServerObject(${rat}); window.acDebug.attack(${rat})`); await a.waitForTimeout(2200);
}
await a.evaluate("window.acDebug.combatMode('peace')"); await a.waitForTimeout(2000);

mark('M6 melee mode with a caster wielded (expect no invented refusal text)');
await a.evaluate("window.acDebug.unwield('MeleeWeapon')"); await a.waitForTimeout(2000);
await adminCommand(a, '@ci 2472'); await a.waitForTimeout(2000); await a.evaluate("window.acDebug.wieldByName('Wand')"); await a.waitForTimeout(2500);
await a.evaluate("window.acDebug.combatMode('melee')"); await a.waitForTimeout(3000);
await a.evaluate("window.acDebug.combatMode('peace')"); await a.waitForTimeout(1500);

mark('M5 bow with no arrows → missile attack');
await adminCommand(a, '@ci 307'); await a.waitForTimeout(2000); await a.evaluate("window.acDebug.wieldByName('Shortbow')"); await a.waitForTimeout(3000);
await adminCommand(a, '@create 7106'); await a.waitForTimeout(2500);
const rat2 = await guidOf('/Rat/');
await a.evaluate("window.acDebug.combatMode('missile')"); await a.waitForTimeout(3000);
await a.evaluate(`window.acDebug.selectServerObject(${rat2}); window.acDebug.attack(${rat2})`); await a.waitForTimeout(3000);
await a.evaluate("window.acDebug.combatMode('peace')"); await a.waitForTimeout(1500);
await a.evaluate(`window.acDebug.selectServerObject(${rat2})`); await adminCommand(a, '@smite'); await a.waitForTimeout(1500);

mark('M12 channel index');
await a.evaluate('window.acDebug.indexChannels()'); await a.waitForTimeout(2500);

mark('M10 open the nearest chest');
const chest = await guidOf('/Chest/');
if (chest) {
  const motions: string[] = [];
  a.on('console', (m) => { if (/0xF74C|movement.*Chest|Chest.*motion/i.test(m.text())) motions.push(m.text().slice(0, 100)); });
  await a.evaluate(`window.acDebug.useObject(${chest})`); await a.waitForTimeout(8000);
  const st = await a.evaluate(`(() => { const an = window.__ac.serverObjectManager.getAnimated(${chest}); const p = an?.motionManager?.player; return JSON.stringify({ queued: an?.motionManager?.linkQueue?.length ?? null, speed: p?.playbackSpeed ?? null }); })()`);
  lines.push('chest anim ' + st);
}

mark('M8 trade opened then closed by B');
const B = await enterWorld({ url: urlFor('testacjs3'), gpu: true }); const b = B.page;
await settle(b, '@teleto TestPartner');
const aOnB = await b.evaluate(`(window.acDebug.listServerObjects().find(o => /TestPartner/.test(o.name)) || {}).guid || 0`);
await b.evaluate(`window.acDebug.tradeOpen(${aOnB})`); await b.waitForTimeout(4000);
await b.evaluate('window.acDebug.tradeClose()'); await b.waitForTimeout(3000);
await B.browser.close();

console.log(lines.join('\n'));
await A.browser.close();
