/**
 * A live check of the missile-strafe rule (MOVE.combination-sweep L6) and the
 * strafe-jump rule on any era's local server: a Bow Hunter charges a shot at
 * the nearest creature, strafes mid-charge (retail: CancelAttack, the build
 * restarts, the release still fires), then jumps while strafing.
 *
 *   AC_BASE=http://localhost:<vite>/ AC_BRIDGE=ws://localhost:<bridge pinned at the era's server> \
 *     npx tsx tools/movement-era-check.ts <era id | eor> <account> [character]
 *
 * The bridge needs BRIDGE_ERA for AC1999 (tools/ac-agent/eras.ts lists each
 * era's ports). Prints the outbound attack / cancel lines and whether the jump
 * left the ground; exits 1 when the release sends no missile attack.
 */
import { adminCommand, enterWorld, createCharacterIfNeeded } from './lib/game-session.ts';

const [eraArg = 'eor', account = 'mvera1', character = 'Mvera Bow'] = process.argv.slice(2);
const era = eraArg === 'eor' ? '' : `&era=${eraArg}`;
const base = process.env.AC_BASE ?? 'http://localhost:3000/';
const bridge = process.env.AC_BRIDGE ?? 'ws://localhost:9090';
const url = `${base}?ace&bridge=${bridge}&account=${account}&password=${account}${era}&cb=mvera-${eraArg}`;
const log = (m: string) => console.log(`[mvera ${eraArg}] ${m}`);

const { browser, page } = await enterWorld({
  url, gpu: process.env.AC_GPU === '1', settleMs: 6000,
  onPoll: createCharacterIfNeeded(character, { template: process.env.MVERA_TEMPLATE ?? (eraArg === 'ac1999-retail' ? 'Archer' : 'Bow Hunter') }),
});
const lines: [number, string][] = [];
page.on('console', (m) => {
  const t = m.text();
  if (/Sent (TargetedMissileAttack|ChangeCombatMode)/.test(t) || (process.env.MVERA_VERBOSE && /\[AC\]|ttack|issile|ammo/i.test(t)) || t.startsWith('[MVERA motion]')) lines.push([Date.now(), t.slice(0, 220)]);
});
const ev = <T>(js: string) => page.evaluate(js) as Promise<T>;
// Every outbound game action we care about, before any era codec rewrites it.
const NAMES: Record<number, string> = { 0x0a: 'TargetedMissileAttack', 0x1b7: 'CancelAttack', 0xf61b: 'Jump', 0xf61c: 'MoveToState' };
await page.exposeFunction('__mveraSent', (type: number) => { if (NAMES[type]) lines.push([Date.now(), `out ${NAMES[type]}`]); });
await ev(`(() => { const c = window.__aceConnection; const o = c.sendMessage.bind(c);
  c.sendMessage = (m, ...r) => { try { const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
    if (v.getUint32(0, true) === 0xF7B1) window.__mveraSent(v.getUint32(8, true)); } catch (e) {} return o(m, ...r); }; })()`);
const settle = async () => {
  await page.waitForTimeout(1500);
  for (let i = 0; i < 80 && !(await ev<boolean>('window.acDebug.collisionState().loginComplete')); i++) await page.waitForTimeout(250);
  await page.waitForTimeout(2500);
};
try {
  // MVERA_ADMIN: ';'-separated commands first (e.g. a @teleloc next to monsters on an admin account).
  for (const c of (process.env.MVERA_ADMIN ?? '').split(';').map((x) => x.trim()).filter(Boolean)) { await adminCommand(page, c); await settle(); }
  if (process.env.MVERA_MOTIONS) await ev(`(() => { const som = window.__ac.serverObjectManager, me = window.__ac.charGuid, o = som.applyParsedMotion.bind(som);
    som.applyParsedMotion = (guid, an, p, ...r) => { if (guid === me) console.log('[MVERA motion] ' + JSON.stringify({ t: p.movementType, style: (p.styleIndex >>> 0).toString(16), fwd: (p.forwardCommand >>> 0).toString(16), auto: p.autonomous, ts: an && an.serverControlSequence, cmds: (p.commands || []).map((c) => (c.command >>> 0).toString(16)) })); return o(guid, an, p, ...r); }; })()`);
  // ClassicACE drops the session on a ranged action before any movement: step first.
  await page.mouse.click(640, 300);
  await page.keyboard.down('KeyW'); await page.waitForTimeout(400); await page.keyboard.up('KeyW');
  await page.waitForTimeout(1500);

  const airborneSoon = async () => { for (let i = 0; i < 40; i++) { if (!(await ev<boolean>('window.acDebug.collisionState().onGround'))) return true; await page.waitForTimeout(25); } return false; };
  await page.keyboard.down('Space'); await page.waitForTimeout(250); await page.keyboard.up('Space');
  const peaceJump = await airborneSoon(); await page.waitForTimeout(1500);
  log(`peace-mode standing jump airborne=${peaceJump}`);
  // MVERA_AMMO: a command run before wielding (e.g. arrows on an admin account; Repeat Attacks spends them).
  if (process.env.MVERA_AMMO) { await adminCommand(page, process.env.MVERA_AMMO); await page.waitForTimeout(3000); }
  const inv = await ev<string[]>('window.__ac.playerState.inventory.getAll().map((i) => i.name)');
  const bow = inv.find((n) => /bow|yumi/i.test(n));
  const ammo = inv.find((n) => /arrows?$/i.test(n) && !/head/i.test(n));
  log(`inventory bow=${bow} ammo=${ammo} (all: ${inv.join(', ')})`);
  for (const n of [bow, ammo]) if (n) { log(`wield ${n}: ${await ev(`window.acDebug.wieldByName(${JSON.stringify(n)})`)}`); await page.waitForTimeout(3000); }
  log(`equipped: ${JSON.stringify(await ev('window.__ac.playerState.equipment.getAll ? window.__ac.playerState.equipment.getAll().map((i) => i.name + \'@0x\' + ((i.currentWieldedLocation ?? i.wieldedLocation ?? 0) >>> 0).toString(16)) : Object.keys(window.__ac.playerState.equipment)'))}`);
  await ev(`window.acDebug.combatMode('missile')`);
  await page.waitForTimeout(3500);
  if (process.env.MVERA_MOTIONS) log(`setup lines:\n${lines.map(([, l]) => '  ' + l).join('\n')}`);
  log(`setup: ${lines.map(([, l]) => l).join(' | ') || 'no combat lines'}`);

  // Stand ~12 m from the nearest creature (a player-level @teleloc on the 1999 server; admin on the others).
  const NEAREST = (range: number) => `(() => {
    const me = window.__ac.charGuid, s = window.acDebug.collisionState();
    let best = null;
    for (const o of window.acDebug.getObjects()) {
      if (o.guid === me || !(o.type & 0x10) || !(o.objectDescFlags & 0x10) || (o.objectDescFlags & 0x208) || !o.pos) continue;
      const d = Math.hypot(o.pos.x - s.x, o.pos.z - s.z);
      if (d < ${range} && (!best || d < best.d)) best = { guid: o.guid, name: o.name, d: +d.toFixed(1), flags: (o.objectDescFlags >>> 0).toString(16), x: o.pos.x, y: o.pos.y, z: o.pos.z, sx: s.x, sz: s.z };
    }
    return best; })()`;
  const far = await ev<{ name: string; d: number; x: number; y: number; z: number; sx: number; sz: number } | null>(NEAREST(250));
  if (far && far.d > 20 && !process.env.MVERA_NO_TELE) {
    const k = 12 / far.d, wx = far.x + (far.sx - far.x) * k, wy = far.z + (far.sz - far.z) * k;
    const lbx = Math.floor(wx / 192), lby = Math.floor(wy / 192), lx = wx - lbx * 192, ly = wy - lby * 192;
    const cell = ((lbx << 24) | (lby << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
    const cmd = `@teleloc 0x${cell.toString(16).toUpperCase().padStart(8, '0')} [${lx.toFixed(2)} ${ly.toFixed(2)} ${(far.y + 1).toFixed(2)}] 1 0 0 0`;
    log(`${far.name} at ${far.d} m: ${cmd}`);
    await adminCommand(page, cmd);
    await settle();
  }
  const target = await ev<{ guid: number; name: string; d: number; flags: string } | null>(NEAREST(40));
  log(`target ${target ? `${target.name} 0x${target.guid.toString(16)} at ${target.d} m (flags 0x${target.flags})` : 'none'}`);
  if (target) await ev(`window.acDebug.select(${target.guid})`);
  await page.waitForTimeout(800);

  if (process.env.MVERA_SHOTS) {
    await page.screenshot({ path: `${process.env.MVERA_SHOTS}/${eraArg}-setup.png` });
    log(`state ${JSON.stringify(await ev('(() => { const c = window.acDebug.collisionState(); return { cell: (c.cellId >>> 0).toString(16), x: c.x, z: c.z, onGround: c.onGround, loginComplete: c.loginComplete, chat: [...document.querySelectorAll(\'#chat-messages [data-chat-text]\')].slice(-8).map((n) => n.dataset.chatText || n.textContent) }; })()'))}`);
  }
  // bow-stand (the baseline): attack held 0.3–1.3 s.
  lines.length = 0;
  let t0 = Date.now();
  const at = async (ms: number) => { const w = t0 + ms - Date.now(); if (w > 0) await page.waitForTimeout(w); };
  await at(300); await page.keyboard.down('End');
  await at(1300); await page.keyboard.up('End');
  await page.waitForTimeout(4000);
  log(`bow-stand:\n${lines.map(([t, l]) => `  +${t - t0} ms ${l}`).join('\n') || '  (nothing sent)'}`);
  const firedStanding = lines.some(([, l]) => /out TargetedMissileAttack/.test(l));

  // A fresh target: the first may have died.
  const next = await ev<{ guid: number; name: string; d: number } | null>(NEAREST(40));
  log(`charge-C target ${next ? `${next.name} 0x${next.guid.toString(16)} at ${next.d} m` : 'none'}`);
  if (next) { await ev(`window.acDebug.select(${next.guid})`); await page.waitForTimeout(800); }
  // bow-charge-C: attack held 0.3–1.3 s, strafe right held 0.6–1.6 s.
  lines.length = 0;
  t0 = Date.now();
  await at(300); await page.keyboard.down('End');
  await at(600); await page.keyboard.down('KeyC');
  await at(1300); await page.keyboard.up('End');
  await at(1600); await page.keyboard.up('KeyC');
  await page.waitForTimeout(3500);
  const charge = lines.map(([t, l]) => `  +${t - t0} ms ${l}`);
  log(`bow-charge-C:\n${charge.join('\n') || '  (nothing sent)'}`);
  log(`chat: ${JSON.stringify(await ev('[...document.querySelectorAll(\'#chat-messages [data-chat-text]\')].slice(-6).map((n) => n.dataset.chatText || n.textContent)'))}`);
  const fired = lines.some(([t, l]) => /out TargetedMissileAttack/.test(l) && t - t0 >= 1250);
  const cancelled = lines.some(([t, l]) => /out CancelAttack/.test(l) && t - t0 >= 550 && t - t0 < 1250);

  // Peace first (a repeat still running holds the server's aim / reload substate),
  // then a standing jump (the baseline) and a strafe-jump.
  await ev(`window.acDebug.combatMode('peace')`);
  await page.waitForTimeout(2500);
  await page.keyboard.down('Space'); await page.waitForTimeout(250); await page.keyboard.up('Space');
  let standJump = false;
  for (let i = 0; i < 40 && !standJump; i++) { standJump = !(await ev<boolean>('window.acDebug.collisionState().onGround')); await page.waitForTimeout(25); }
  await page.waitForTimeout(1500);
  log(`standing jump airborne=${standJump}`);
  // Strafe-jump: hold C, tap Space (a short charge); the body must leave the ground.
  lines.length = 0;
  const tj = Date.now();
  await page.keyboard.down('KeyC'); await page.waitForTimeout(400);
  await page.keyboard.down('Space'); await page.waitForTimeout(250); await page.keyboard.up('Space');
  let airborne = false;
  for (let i = 0; i < 40 && !airborne; i++) { airborne = !(await ev<boolean>('window.acDebug.collisionState().onGround')); await page.waitForTimeout(25); }
  await page.waitForTimeout(800); await page.keyboard.up('KeyC');
  log(`strafe-jump airborne=${airborne}${airborne ? '' : `\n${lines.map(([t, l]) => `  +${t - tj} ms ${l}`).join('\n')}`}`);
  log(`RESULT firedStanding=${firedStanding} standJump=${standJump} cancelOnStrafe=${cancelled} firedOnRelease=${fired} strafeJump=${airborne}`);
  process.exitCode = fired && airborne ? 0 : 1;
} finally {
  await browser.close().catch(() => {});
}
