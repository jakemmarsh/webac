/**
 * probe-chest-open-motion — DECOMP.chest-open-extra-motion live check.
 * ClientUISystem::OnViewContents @ 00565870 plays nothing on the container:
 * the lid opens only from ACE's own broadcast (Chest.cs motionOpen →
 * ExecuteMotion → 0xF74C MovementEvent). So opening a chest must drive the
 * chest's MotionManager exactly once per server motion (one On on open, one
 * Off on close), never a second local On.
 *
 * `@create 143` (ACE 'chest') ahead of the player, every MotionManager entry
 * point on the chest's own instance is wrapped and logged next to each
 * MovementEvent for that guid, then the chest is opened (acDebug.useObject)
 * and closed again. Screenshot to verification/chest-open-motion/.
 *
 * Usage: npx tsx tools/probe-chest-open-motion.ts [--create-char Name]
 */
import { mkdirSync } from 'node:fs';
import { enterWorld, adminCommand, shot, sessionArgs } from './lib/game-session.js';

const OUT = 'verification/chest-open-motion';
const CHEST_WCID = 143;
const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };

const HOOK_JS = `(() => {
  const ac = window.__ac, som = ac.serverObjectManager;
  let guid = 0;
  for (const [g, o] of som.getAllObjects()) if (o.weenieClassId === ${CHEST_WCID} && (g >>> 0) >= 0x80000000) guid = g;  // the @created (dynamic) chest, never a landblock one
  if (!guid) return 0;
  const log = window.__chestLog = [];
  const t0 = performance.now();
  let inMove = false;
  const anim = som.getAnimated(guid);
  const mm = anim && anim.motionManager;
  if (!mm) return -1;
  for (const name of ['setStanceFromId', 'changeStyle', 'setStance', 'setDefaultStance', 'queueAction', 'setForwardMotion', 'requestMotion', 'playDeath']) {
    const orig = mm[name].bind(mm);
    mm[name] = (...a) => { log.push({ t: Math.round(performance.now() - t0), call: name, fromServer: inMove, args: a.map((v) => typeof v === 'number' ? '0x' + (v >>> 0).toString(16) : String(v)), ...(inMove ? {} : { stack: (new Error().stack || '').split('\\n').slice(2, 7).map((l) => l.trim()) }) }); return orig(...a); };
  }
  const origMove = som.handleMovementEvent.bind(som);
  som.handleMovementEvent = (d) => { if (d.guid === guid) log.push({ t: Math.round(performance.now() - t0), call: 'MovementEvent(0xF74C)' }); inMove = d.guid === guid; try { return origMove(d); } finally { inMove = false; } };
  return guid;
})()`;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ ...sessionArgs(), cb: 'probe-chest-open', settleMs: 5000, createCharacter: arg('create-char') });
  const { page } = s;
  await adminCommand(page, `@create ${CHEST_WCID}`);
  let guid = 0;
  for (let t = 0; t < 20_000 && !(guid = await page.evaluate(HOOK_JS) as number); t += 500) await page.waitForTimeout(500);
  if (guid <= 0) throw new Error(`chest not found / no MotionManager (${guid})`);
  console.log(`chest guid 0x${(guid >>> 0).toString(16)}`);
  await page.waitForTimeout(1500);

  await page.evaluate(`window.acDebug.useObject(${guid})`);
  // The container's range entry (CHECK_GROUND_OBJECT_INTERVAL at its UseRadius) while it is open.
  for (let i = 0; i < 16; i++) {
    const r = await page.evaluate('window.acDebug.objectRangeChecks()') as { entries: unknown[]; containerVisible: boolean };
    console.log(`range t+${i * 250}ms visible=${r.containerVisible}`, JSON.stringify(r.entries));
    await page.waitForTimeout(250);
  }
  const open = await page.evaluate('window.__chestLog.splice(0)') as unknown[];
  const panel = await page.evaluate('!!(window.__ac.gameUI && window.__ac.gameUI.isContainerOpen)');
  await shot(page, `${OUT}/chest-open.png`);
  console.log('panel open:', panel);
  console.log('OPEN log:', JSON.stringify(open, null, 1));

  await page.evaluate(`window.acDebug.useObject(${guid})`);
  await page.waitForTimeout(4000);
  const close = await page.evaluate('window.__chestLog.splice(0)') as unknown[];
  await shot(page, `${OUT}/chest-closed.png`);
  console.log('CLOSE log:', JSON.stringify(close, null, 1));

  type Entry = { call: string; fromServer?: boolean; stack?: string[] };
  // A MotionManager advancing its own queue (link → cycle) is not a new motion.
  const internal = (e: Entry): boolean => !!e.stack?.some((l) => l.includes('MotionManager.update'));
  const events = (open as Entry[]).filter((e) => e.call === 'MovementEvent(0xF74C)').length;
  const local = [...open, ...close].filter((e) => (e as Entry).call !== 'MovementEvent(0xF74C)' && !(e as Entry).fromServer && !internal(e as Entry)).length;
  console.log(`open: ${events} MovementEvent(s); MotionManager calls outside a MovementEvent (open+close): ${local}`);
  await s.browser.close();
  console.log(events >= 1 && local === 0 ? 'PASS' : 'FAIL');
}
main().catch((e) => { console.error(e); process.exit(1); });
