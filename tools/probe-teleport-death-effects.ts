/**
 * probe-teleport-death-effects — what a teleport, a lifestone recall, a death
 * and a wield PLAY, locally vs from the server (BUG.duplicate-local-sounds,
 * BUG.nonpositional-human-table-sounds, BUG.invented-portal-burst-and-spell-effects,
 * 2026-09-28).
 *
 * Records, from world entry on:
 *  - every PlayScript / PlayEffect the page resolved (console `[AC] PScript …`
 *    / `[AC] PlayEffect …`): the login / teleport Hidden (0x76) and UnHide
 *    (0x75) scripts our own set_hidden plays, the server's Hide (0x74);
 *  - every DAT emitter spawned (0x32… id, part);
 *  - every UI-table sound (SoundPlayer.playGameSound — retail's
 *    PlaySoundFromCenter: only UI_EnterPortal / UI_ExitPortal / Environs /
 *    UI_ButtonPress may appear) and every positional sound (server Sound
 *    messages and animation hooks, at the object);
 *  - playUISound refusals (a non-retail sound some path still asked for);
 * and a CDP screencast around each teleport arrival.
 *
 *   AC_ACCOUNT=fxprobe3 AC_PASSWORD=fxprobe3 AC_BASE=http://localhost:3091/ \
 *     npx tsx tools/probe-teleport-death-effects.ts [--gpu] [--skip-death] [--skip-recall]
 *
 * Output: verification/effects/teleport-death/ (report.json + frames).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { openSession, gameUrl, waitForWorld, adminCommand, sessionArgs, createCharacterIfNeeded } from './lib/game-session.js';

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(`--${f}`);
const OUT = 'verification/effects/teleport-death';

const HOOK = `(() => {
  const ac = window.__ac;
  const rec = window.__td = { t0: performance.now(), phase: 'login', ui: [], positional: [], emitters: [], refusals: [] };
  const t = () => Math.round(performance.now() - rec.t0);
  const hex = (n) => '0x' + ((n >>> 0).toString(16));
  const sp = ac.soundPlayer;
  const origGame = sp.playGameSound.bind(sp);
  sp.playGameSound = (table, sound, cat, vol) => { rec.ui.push({ t: t(), phase: rec.phase, table: hex(table), sound }); return origGame(table, sound, cat, vol); };
  const origPos = sp.playPositionalSound.bind(sp);
  sp.playPositionalSound = (wave, pos, listener, category, volume) => {
    rec.positional.push({ t: t(), phase: rec.phase, wave: hex(wave), dist: +Math.hypot(pos.x - listener.x, pos.y - listener.y, pos.z - listener.z).toFixed(1) });
    return origPos(wave, pos, listener, category, volume);
  };
  const fx = ac.spellEffects, origSpawn = fx.spawnParticleEffect.bind(fx);
  fx.spawnParticleEffect = (...a) => { const [info, , , , , , opts] = a; rec.emitters.push({ t: t(), phase: rec.phase, emitter: hex(info.id), part: opts && opts.partIndex !== undefined ? opts.partIndex : null }); return origSpawn(...a); };
  const origWarn = console.warn.bind(console);
  console.warn = (...a) => { const s = String(a[0]); if (/playUISound/.test(s)) rec.refusals.push({ t: t(), phase: rec.phase, line: s.slice(5, 140) }); return origWarn(...a); };
  return 'hooked';
})()`;

async function main(): Promise<void> {
  const scripts: Array<{ ms: number; phase: string; line: string }> = [];
  let phase = 'login';
  const t0 = Date.now();
  const s = await openSession(sessionArgs(argv));
  const page = s.page;
  // The login Hidden script fires at our own CreateObject, before the
  // in-page hook exists: listen from the first page load.
  page.on('console', (m) => {
    const x = m.text();
    if (/\[AC\] (PScript|PlayEffect|PlayScript|Sound 0x|ACE: Sent recall)|\[WeenieError\]/.test(x)) scripts.push({ ms: Date.now() - t0, phase, line: x.slice(0, 160) });
  });
  const url = gameUrl({ cb: 'probe-teleport-death' });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const create = argv.includes('--create-char') ? argv[argv.indexOf('--create-char') + 1] : undefined;
  if (!(await waitForWorld(page, { url, onPoll: create ? createCharacterIfNeeded(create) : undefined }))) throw new Error('never entered the world');
  await page.waitForTimeout(4000);
  // A user gesture opens the AudioContext (initAudio): without it every
  // server Sound message is dropped before it is even resolved.
  await page.mouse.click(780, 120);
  await page.waitForTimeout(500);
  console.log(await page.evaluate(HOOK));
  const setPhase = async (p: string): Promise<void> => { phase = p; await page.evaluate(`window.__td.phase = ${JSON.stringify(p)}`); };
  await adminCommand(page, '@god');
  await page.waitForTimeout(3000);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  let frameTag = '';
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
    if (frameTag) writeFileSync(`${OUT}/${frameTag}-${String(Date.now() - t0).padStart(7, '0')}.jpg`, Buffer.from(f.data, 'base64'));
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 3 });

  // 1. Wield: the WieldObject chime is the server's Sound message on us.
  await setPhase('wield');
  await adminCommand(page, '@ci 4799');
  await page.waitForTimeout(3000);
  await page.evaluate(`window.acDebug.equip('Practice Wand', 'Held')`);
  await page.waitForTimeout(4000);

  // 2. Teleport: Hidden on departure, UnHide on arrival, the tunnel's pair.
  await setPhase('teleport');
  frameTag = 'teleport';
  await adminCommand(page, '@telepoi holtburg');
  await page.waitForTimeout(25_000);
  frameTag = '';

  // 3. Lifestone recall: the server's Hide script first (DoPreTeleportHide).
  if (!has('skip-recall')) {
    // Attune to the nearest lifestone first (Holtburg's is by the landing
    // point): ACE's LifestoneOn chime is its Sound message (Lifestone.cs:58).
    await setPhase('attune');
    const ls = await page.evaluate(`(() => { const me = window.__ac.playerModel.position; const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => /life ?stone/i.test(o.name || ''))
      .sort((a, b) => Math.hypot(a.worldX - me.x, a.worldZ - me.z) - Math.hypot(b.worldX - me.x, b.worldZ - me.z))[0]; return o ? o.guid : 0; })()`) as number;
    if (ls) {
      await page.evaluate(`window.acDebug.useObject(${ls})`);
      await page.waitForTimeout(15_000);
    } else {
      console.log('no lifestone in view — attune skipped');
    }
    await setPhase('recall');
    frameTag = 'recall';
    // The chat box's own keydown path (recall commands are intercepted there).
    await page.focus('#chat-input');
    await page.keyboard.type('/ls');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(35_000);
    frameTag = '';
  }

  // 4. Death: the Dead link's Knockdown3 hook from our own table; the
  //    respawn is another Hidden / UnHide teleport.
  if (!has('skip-death')) {
    await setPhase('death');
    frameTag = 'death';
    const name = await page.evaluate('window.__ac.playerState.name') as string;
    await adminCommand(page, `@smite ${name}`);
    await page.waitForTimeout(30_000);
    frameTag = '';
  }
  await cdp.send('Page.stopScreencast');

  const rec = JSON.parse(await page.evaluate('JSON.stringify(window.__td)') as string) as {
    ui: Array<{ phase: string; sound: number; t: number }>;
    positional: Array<{ phase: string; wave: string; dist: number; t: number }>;
    emitters: Array<{ phase: string; emitter: string; part: number | null }>;
    refusals: Array<{ phase: string; line: string }>;
  };
  // Keep the sounds at our own position (the far ambient / scenery waves
  // repeat every tick and would bury them).
  const near = rec.positional.filter((x) => x.dist < 6);
  const report = { scripts, ...rec, positional: near, positionalNote: `only sounds within 6 m of the listener kept (${near.length} of ${rec.positional.length})` };
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  const byPhase = <T extends { phase: string }>(xs: T[], p: string): T[] => xs.filter((x) => x.phase === p);
  for (const p of ['login', 'wield', 'teleport', 'attune', 'recall', 'death']) {
    console.log(`=== ${p}`);
    for (const x of byPhase(scripts, p)) console.log(`  ${x.ms} ${x.line}`);
    console.log(`  UI-table sounds: ${byPhase(rec.ui, p).map((x) => `${x.sound}@${x.t}`).join(' ') || 'none'}`);
    // Sounds at our own position (the camera is ~3–5 m behind the player); the
    // far ambient / scenery ones are left to report.json.
    console.log(`  positional within 6 m: ${byPhase(rec.positional, p).filter((x) => x.dist < 6).map((x) => `${x.wave}(${x.dist}m)@${x.t}`).join(' ') || 'none'}`);
    const em = new Map<string, number>();
    for (const e of byPhase(rec.emitters, p)) em.set(`${e.emitter}@${e.part}`, (em.get(`${e.emitter}@${e.part}`) ?? 0) + 1);
    console.log(`  emitters: ${[...em].map(([k, n]) => `${k}×${n}`).join(' ') || 'none'}`);
    console.log(`  playUISound refusals: ${byPhase(rec.refusals, p).map((x) => x.line).join(' | ') || 'none'}`);
  }
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
