/**
 * FX.player-transplant-kills-part-emitters live probe (end of retail): an
 * endless emitter rides our character's part 12; we unequip and re-wield a
 * worn item (each an own ObjDescEvent → AppearanceOverrides part transplant)
 * and report whether the emitter is still alive and still follows part 12,
 * plus the player's translucency and part count.
 *
 *   AC_BASE=http://localhost:3021/ AC_BRIDGE=ws://localhost:9193 AC_ACCOUNT=portalfix1 AC_PASSWORD=portalfix1pw \
 *     npx tsx tools/probe-transplant-part-state.ts <outdir>
 */
import { join } from 'node:path';
import { enterWorld, shot } from './lib/game-session.js';
const out = process.argv[2];
const { browser, page } = await enterWorld({ createCharacter: 'Portalfix', settleMs: 6000, viewport: { width: 1280, height: 720 } });
const ev = <T = unknown>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const state = () => ev<Record<string, unknown>>(`(() => {
  const ac = window.__ac; const pm = ac.playerModel; const sys = ac.physicsScriptPlayer.objectSystems.get(pm);
  const live = sys ? [...sys].filter(s => !s.isDone && !s.isDisposed) : [];
  const parts = pm.children.filter(c => /^part_/.test(c.name));
  return { systems: sys ? sys.size : 0, live: live.length, uuids: parts.map(p => p.uuid.slice(0, 6)).join(','), translucency: pm.userData.acTranslucency ?? 0 };
})()`);
// An endless emitter on part 12 (the portal swirl 0x320002CD).
await ev(`window.__ac.physicsScriptPlayer.play({ id: 0x3300ffff, steps: Array.from({ length: 34 }, (_, i) => ({ startTime: 0, hook: { hookType: 13, direction: 0, emitterInfoId: 0x320002cd, partIndex: i, offset: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, emitterId: 0 } })) }, window.__ac.playerModel)`);
await page.waitForTimeout(2000);
console.log('BEFORE', JSON.stringify(await state()));
const worn = await ev<Array<{ slot: string; name: string; id: string }>>(`window.acDebug.equipped()`);
console.log('WORN', JSON.stringify(worn));
const item = worn.find((w) => /Doublet|Shirt|Tunic/.test(w.name)) ?? worn[0];
if (item) {
  await ev(`window.acDebug.unwield(${Number(item.slot)})`).catch((e) => console.log('unequip err', String(e)));
  await page.waitForTimeout(3000);
  console.log('AFTER-UNEQUIP', JSON.stringify(await state()));
  await ev(`window.acDebug.equip(${JSON.stringify(item.name)})`);
  await page.waitForTimeout(3000);
  console.log('AFTER-REEQUIP', JSON.stringify(await state()));
}
await shot(page, join(out, 'transplant.png'));
await browser.close();
