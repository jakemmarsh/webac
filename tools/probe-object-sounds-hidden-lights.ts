/**
 * probe-object-sounds-hidden-lights — live check for
 * BUG.server-sound-not-positional, BUG.invented-portal-hum-timer,
 * BUG.invented-landing-dust-footstep and BUG.hidden-object-lights-leave-pool.
 *
 *  1. Holtburg portal (0xA9B40003, setup 0x020001B3): records every sound
 *     for 12 s beside it. Retail: the portal's DefaultScript hum 0x0A00038E
 *     at volume 0.05 every ~2.7 s, positional AT the portal; the invented
 *     0x0A00009C timer is gone.
 *  2. Landing: a charged jump; records particle bursts and non-positional
 *     sounds from launch to landing (retail: none).
 *  3. Server sounds (dungeon 0x86020115, a Young Olthoi attacking): every
 *     server Sound plays AT its object (the player / the creature) at the
 *     server's volume; no non-positional effect sound.
 *  4. Hidden lights: a Tiki Torch (22857, LightingOn) is set Hidden through
 *     ServerObjectManager.setPhysicsState (the SetState path); its light must
 *     stay lit and the rendered point-light count must not change.
 *
 * Usage (own account — never testacjs / testacjs2):
 *   AC_ACCOUNT=fxprobe2 AC_PASSWORD=fxprobe2 AC_BASE=http://localhost:3097/ \
 *     npx tsx tools/probe-object-sounds-hidden-lights.ts [--gpu] [--out verification/effects/object-sounds-hidden-lights]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand, collisionState } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = arg('out') ?? 'verification/effects/object-sounds-hidden-lights';
const PORTAL_AT = arg('portal') ?? '@teleloc 0xA9B40003 [19 55.6 78.2] 1 0 0 0';
const DUNGEON = arg('teleloc') ?? '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';

/** In-page recorders: positional + centre sounds, particle bursts. */
const HOOK = `(() => {
  const ac = window.__ac;
  const rec = window.__osl = { t0: performance.now(), pos: [], centre: [], bursts: [] };
  const t = () => Math.round(performance.now() - rec.t0);
  const sp = ac.soundPlayer;
  const nearest = (p) => {
    let near = null, best = Infinity;
    for (const o of ac.serverObjectManager.getAllObjects().values()) {
      const d = Math.hypot(o.worldX - p.x, o.worldZ - p.z);
      if (d < best) { best = d; near = o.name + ' 0x' + o.guid.toString(16); }
    }
    const pm = ac.playerModel;
    if (pm && Math.hypot(pm.position.x - p.x, pm.position.z - p.z) < 0.01) return 'PLAYER';
    return best < 1.5 ? near : 'other';
  };
  const pp = sp.playPositionalSound.bind(sp);
  sp.playPositionalSound = (wave, pos, listener, category, volume) => {
    rec.pos.push({ t: t(), wave: '0x' + (wave >>> 0).toString(16), from: nearest(pos),
      dist: +Math.hypot(pos.x - listener.x, pos.y - listener.y, pos.z - listener.z).toFixed(1),
      volume: volume === undefined ? 1 : +(+volume).toFixed(3), category });
    return pp(wave, pos, listener, category, volume);
  };
  const ps = sp.playSound.bind(sp);
  sp.playSound = (wave, category, volume) => {
    rec.centre.push({ t: t(), wave: '0x' + (wave >>> 0).toString(16), category, volume: +(+volume).toFixed(3) });
    return ps(wave, category, volume);
  };
  const se = ac.spellEffects, pb = se.spawnParticleBurst.bind(se);
  se.spawnParticleBurst = (...a) => { rec.bursts.push({ t: t(), color: '0x' + (a[1] >>> 0).toString(16) }); return pb(...a); };
  return 'hooked';
})()`;

const now = (page: import('playwright').Page): Promise<number> => page.evaluate('Math.round(performance.now() - window.__osl.t0)') as Promise<number>;

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-object-sounds-hidden-lights' } as never);
  const page = s.page;
  // The client logs every server Sound message and what it did with it.
  const serverSoundLog: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[AC] Sound ')) serverSoundLog.push(t); });
  const report: Record<string, unknown> = {};
  await page.waitForTimeout(3000);
  console.log(await page.evaluate(HOOK));
  await page.mouse.click(4, 300); // audio starts on the first document click
  await page.waitForTimeout(1000);
  console.log('audio context:', await page.evaluate('String(window.__ac.audioManager.audioContext && window.__ac.audioManager.audioContext.state)'));

  // 1. Holtburg portal hum.
  await adminCommand(page, PORTAL_AT);
  await page.waitForTimeout(20_000);
  await page.evaluate('window.__osl.pos = []; window.__osl.centre = []');
  await page.waitForTimeout(12_000);
  const portalSounds = await page.evaluate('window.__osl.pos') as Array<{ wave: string; from: string; t: number; volume: number; dist: number }>;
  const hums = portalSounds.filter((x) => x.wave === '0xa00038e');
  report.portal = {
    hums, invented: portalSounds.filter((x) => x.wave === '0xa00009c'), all: portalSounds,
    portalsNear: await page.evaluate(`[...window.__ac.serverObjectManager.getAllObjects().values()].filter(o => o.setupId === 0x020001b3).map(o => ({ name: o.name, guid: '0x' + o.guid.toString(16) }))`),
  };
  console.log(`portal: ${hums.length} hums in 12 s`, JSON.stringify(hums.slice(0, 6)), '; invented 0x0a00009c plays:', (report.portal as { invented: unknown[] }).invented.length);
  await page.screenshot({ path: `${OUT}/portal.jpg`, type: 'jpeg', quality: 80 });

  // 2. Landing.
  await page.evaluate('window.__osl.pos = []; window.__osl.centre = []; window.__osl.bursts = []');
  const y0 = ((await collisionState(page)).feetY as number) ?? 0;
  await page.keyboard.down('Space'); await page.waitForTimeout(1000); await page.keyboard.up('Space');
  let airborne = false;
  for (let i = 0; i < 40; i++) {
    const cs = await collisionState(page);
    if (cs.onGround === false || ((cs.feetY as number) ?? y0) > y0 + 0.05) airborne = true;
    await page.waitForTimeout(100);
  }
  report.landing = {
    airborneSeen: airborne,
    jumpStats: await page.evaluate('window.acDebug && window.acDebug.jumpStats ? window.acDebug.jumpStats() : null'),
    bursts: await page.evaluate('window.__osl.bursts'),
    centreSounds: await page.evaluate('window.__osl.centre'),
    positionalSounds: await page.evaluate('window.__osl.pos'),
  };
  console.log('landing:', JSON.stringify(report.landing));

  // 3. Server Sound messages (ACE @playsound → GameMessageSound(guid, sound, volume)):
  //    on the player, on a creature with a table, on a portal with none, on an unknown guid.
  const targets = await page.evaluate(`(() => {
    const ac = window.__ac, me = ac.playerModel.position;
    const all = [...ac.serverObjectManager.getAllObjects().values()].filter(o => o.mesh && o.guid !== ac.charGuid);
    const d = (o) => Math.hypot(o.worldX - me.x, o.worldZ - me.z);
    const creature = all.filter(o => o.soundTableId && o.motionTableId).sort((a, b) => d(a) - d(b))[0];
    const portal = all.filter(o => o.setupId === 0x020001b3 && !o.soundTableId).sort((a, b) => d(a) - d(b))[0];
    const h = (o) => o ? { guid: o.guid.toString(16), name: o.name, table: '0x' + (o.soundTableId >>> 0).toString(16), dist: +d(o).toFixed(1) } : null;
    return { player: ac.charGuid.toString(16), playerTable: '0x' + ((ac.playerModel.userData.soundTableId ?? 0) >>> 0).toString(16), creature: h(creature), portal: h(portal) };
  })()`) as { player: string; playerTable: string; creature: { guid: string } | null; portal: { guid: string } | null };
  console.log('playsound targets:', JSON.stringify(targets));
  await page.evaluate('window.__osl.pos = []; window.__osl.centre = []');
  serverSoundLog.length = 0;
  await adminCommand(page, '@playsound Wound3 0.5');
  await page.waitForTimeout(2500);
  if (targets.creature) { await adminCommand(page, `@playsound Wound3 1 ${targets.creature.guid}`); await page.waitForTimeout(2500); }
  if (targets.portal) { await adminCommand(page, `@playsound Wound3 1 ${targets.portal.guid}`); await page.waitForTimeout(2500); }
  await adminCommand(page, '@playsound Wound3 1 80fff123');
  await page.waitForTimeout(2500);
  const woundWaves = await page.evaluate(`(() => { const t = window.__ac.soundPlayer.loadSoundTable(0x20000001); const e = t && t.data.get(0x0e); return e ? e.data.map(d => '0x' + d.soundId.toString(16)) : []; })()`);
  report.playsound = {
    targets, woundWavesHuman: woundWaves, messages: serverSoundLog.slice(),
    positional: await page.evaluate('window.__osl.pos'), centre: await page.evaluate('window.__osl.centre'),
  };
  console.log('playsound messages:', JSON.stringify(serverSoundLog));
  console.log('playsound positional:', JSON.stringify((report.playsound as { positional: unknown[] }).positional.filter((x) => /PLAYER|0x/.test(JSON.stringify(x)) && (x as { category?: string }).category === 'effects')));
  console.log('playsound centre:', JSON.stringify((report.playsound as { centre: unknown[] }).centre.filter((x) => (x as { category: string }).category !== 'ambient')));

  // 4. Dungeon: torch + creature.
  await adminCommand(page, DUNGEON);
  await page.waitForTimeout(20_000);
  await adminCommand(page, '@create 22857');
  await page.waitForTimeout(4000);
  const torchState = `(() => {
    const ac = window.__ac, scene = ac.sceneManager.scene;
    scene.updateMatrixWorld();
    let visiblePoint = 0, objectLightsRendered = 0;
    scene.traverseVisible((o) => { if (o.isPointLight) { visiblePoint++; if (o.name.startsWith('object-light')) objectLightsRendered++; } });
    const torch = [...ac.serverObjectManager.getAllObjects().values()].filter(o => o.setupId === 0x020009a3).pop();
    if (!torch) return { visiblePoint, objectLightsRendered, torch: null };
    const carrier = scene.children.find(c => c.name === 'object-light-carrier' && c.owner === torch.mesh);
    const r = ac.sceneManager.renderer;
    return { visiblePoint, objectLightsRendered, programs: r && r.info.programs ? r.info.programs.length : -1,
      torch: { guid: torch.guid, phys: '0x' + (torch.physicsState >>> 0).toString(16), meshVisible: torch.mesh.visible,
        carrierVisible: carrier ? carrier.visible : null, lights: carrier ? carrier.children.map(l => ({ lit: l.visible })) : [] } };
  })()`;
  // The pool enables the light once the torch's cell pass is known — wait for it.
  let lit = await page.evaluate(torchState) as { torch: { guid: number; phys: string; lights: Array<{ lit: boolean }> } | null };
  for (let i = 0; i < 40 && !(lit.torch && lit.torch.lights.some((l) => l.lit)); i++) {
    await page.waitForTimeout(250);
    lit = await page.evaluate(torchState) as typeof lit;
  }
  await page.screenshot({ path: `${OUT}/torch-shown.jpg`, type: 'jpeg', quality: 80 });
  let hidden: unknown = null;
  if (lit.torch) {
    await page.evaluate(`(() => { const som = window.__ac.serverObjectManager; const o = som.getObject(${lit.torch.guid}); som.setPhysicsState(o.guid, (o.physicsState | 0x4000) >>> 0); })()`);
    await page.waitForTimeout(1500);
    hidden = await page.evaluate(torchState);
    await page.screenshot({ path: `${OUT}/torch-hidden.jpg`, type: 'jpeg', quality: 80 });
  }
  report.hiddenLights = { shown: lit, hidden };
  console.log('torch shown:', JSON.stringify(lit));
  console.log('torch hidden:', JSON.stringify(hidden));

  await page.evaluate('window.__osl.pos = []; window.__osl.centre = []');
  const t0 = await now(page);
  await adminCommand(page, '@create 7089');
  await page.waitForTimeout(25_000);
  const combat = await page.evaluate('window.__osl.pos') as Array<{ from: string; wave: string; volume: number }>;
  const centre = await page.evaluate('window.__osl.centre') as Array<{ category: string }>;
  const playerGuid = await page.evaluate('window.__ac.charGuid') as number;
  report.serverSounds = { since: t0, playerGuid: '0x' + (playerGuid >>> 0).toString(16), messages: serverSoundLog.slice(), positional: combat, centre };
  console.log(`server Sound messages: ${serverSoundLog.length}`);
  for (const l of serverSoundLog.slice(0, 16)) console.log('  ', l);
  const bySource = new Map<string, number>();
  for (const x of combat) bySource.set(x.from, (bySource.get(x.from) ?? 0) + 1);
  console.log(`server/anim sounds in 15 s: ${combat.length} positional (${[...bySource].map(([k, n]) => `${k}×${n}`).join(', ')}), ${centre.length} non-positional`);
  for (const x of combat.filter((c) => c.from === 'PLAYER').slice(0, 12)) console.log('   at player:', JSON.stringify(x));
  for (const x of centre.slice(0, 12)) console.log('   centre:', JSON.stringify(x));

  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
