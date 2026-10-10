/**
 * probe-decomp-observers — live two-client checks for the 2026-09-30 decomp-diff
 * fixes that only show from another player's point of view. Client A
 * (testacjs2 / TestPartner) acts; client B (testacjs3 / Obsprobe) watches from
 * next to it through its own ServerObjectManager.
 *   W2 PickupEvent: A picks up a coin stack; B must stop drawing it.
 *   W8 held item across an ObjDesc rebuild: A wields a cap; B must still see A's held item.
 *   A3 cycles loop: A goes AFK; B's copy of A keeps cycling past one pass.
 *   A10 style change at 1.0: B's copy of A plays the combat-stance transition at speed 1.
 * Usage: npx tsx tools/probe-decomp-observers.ts   (vite :3000 + bridge + ACE; one live run at a time)
 */
import { enterWorld, adminCommand, gameUrl } from './lib/game-session.ts';

const urlFor = (account: string) => gameUrl({ cb: 'observers', env: { ...process.env, AC_ACCOUNT: account, AC_PASSWORD: account } });

const A = await enterWorld({ url: urlFor('testacjs2') });
const B = await enterWorld({ url: urlFor('testacjs3') });
const a = A.page, b = B.page;
await a.waitForTimeout(4000);
await adminCommand(a, '@telepoi Holtburg');
await a.waitForTimeout(15000);
await adminCommand(b, '@teleto TestPartner');
await b.waitForTimeout(15000);
const aGuid = await a.evaluate('window.acDebug.playerAnimState().guid ?? window.__ac.playerState.guid ?? 0').catch(() => 0) as number;
const aGuidOnB = await b.evaluate(`(window.acDebug.listServerObjects().find(o => /TestPartner/.test(o.name)) || {}).guid || 0`) as number;
const results: Record<string, string> = {};
const onB = (js: string) => b.evaluate(`(() => { const som = window.__ac.serverObjectManager; ${js} })()`);

// W2 — pickup
await adminCommand(a, '@create 273');
await a.waitForTimeout(4000);
const coinB = await b.evaluate(`(window.acDebug.listServerObjects().filter(o => /pyreal/i.test(o.name)).pop() || {}).guid || 0`) as number;
const coinVisibleBefore = coinB ? await onB(`const o = som.getObject(${coinB}); return !!(o && o.mesh && o.mesh.visible && o.mesh.parent);`) : false;
if (coinB) {
  await a.evaluate(`window.acDebug.putInPack(${coinB}, ${aGuidOnB})`);
  await a.waitForTimeout(5000);
}
const coinVisibleAfter = coinB ? await onB(`const o = som.getObject(${coinB}); return !!(o && o.mesh && o.mesh.visible && o.mesh.parent && !o.outOfWorld);`) : null;
results.W2 = `coin 0x${(coinB >>> 0).toString(16)} visible on B before=${coinVisibleBefore} after pickup=${coinVisibleAfter}`;

// W8 — held item survives A's appearance rebuild
const heldBefore = aGuidOnB ? await onB(`const o = som.getObject(${aGuidOnB}); let n = 0; o && o.mesh && o.mesh.traverse(c => { if (/^wielded_/.test(c.name)) n++; }); return n;`) : -1;
await adminCommand(a, '@ci 45');
await a.waitForTimeout(3000);
const wielded = await a.evaluate(`window.acDebug.wieldByName('Leather Cap')`);
await a.waitForTimeout(5000);
const heldAfter = aGuidOnB ? await onB(`const o = som.getObject(${aGuidOnB}); let n = 0; o && o.mesh && o.mesh.traverse(c => { if (/^wielded_/.test(c.name)) n++; }); return n;`) : -1;
results.W8 = `A's held items seen by B before=${heldBefore} after wielding a cap (sent=${wielded})=${heldAfter}`;

// A3 — AFK cycle keeps looping on B's copy of A
await a.evaluate('window.acDebug.setAfkMode(true)');
await a.waitForTimeout(2000);
const sample = () => onB(`const an = som.getAnimated(${aGuidOnB}); if (!an) return null; const p = an.motionManager.player; return { t: p.currentTime ?? p.time ?? 0, frame: p.currentFrame ?? p.frame ?? 0, loops: p.loopCount ?? null };`);
const s1 = await sample(); await a.waitForTimeout(4000); const s2 = await sample();
results.A3 = `AFK on B: ${JSON.stringify(s1)} → 4 s later ${JSON.stringify(s2)}`;
await a.evaluate('window.acDebug.setAfkMode(false)');

// A10 — combat-stance transition speed on B's copy of A
await a.waitForTimeout(2000);
await a.evaluate("window.acDebug.combatMode('melee')");
await a.waitForTimeout(400);
const sp = await onB(`const an = som.getAnimated(${aGuidOnB}); return an ? an.motionManager.player.playbackSpeed : null;`);
results.A10 = `B's copy of A: playback speed during the stance change = ${sp}`;
await a.evaluate("window.acDebug.combatMode('peace')");

console.log(JSON.stringify({ aGuid, aGuidOnB, ...results }, null, 2));
await A.browser.close(); await B.browser.close();
