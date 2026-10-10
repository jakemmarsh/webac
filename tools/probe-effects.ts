/**
 * probe-effects — record what a spell cast DRAWS, and why (BUG.spellcast-effects).
 *
 * For each cast it records, in the page:
 *  - every particle emitter spawned (ParticleEmitterInfo 0x32… id, the anchor
 *    it rides, part index, sprite texture / additive bit) — the DAT path;
 *  - every PROCEDURAL SpellEffects call (createCastingSwirl, spawnProjectile,
 *    createImpactFlash, createWeaponImpact, …) — client-invented art retail never
 *    drew; a clean retail-faithful cast shows none of these for its own
 *    choreography;
 *  - every PlayScript (enum → the DAT script it resolved to, or FALLBACK),
 *    every animation hook the caster's motion fired (CreateParticle /
 *    StopParticle / …), every CreateObject (server spell projectiles);
 * and streams a CDP screencast of the cast (screenshots stall the renderer
 * for seconds under the headless GPU; the screencast does not), with the
 * camera orbited to face the caster so the hands are visible.
 *
 * It also records (BUG.server-object-setup-lights / BUG.remote-anim-sound-hooks)
 * every positional sound started (wave, distance from the listener, volume)
 * and, at every render of the world scene, the light pool: dynamic / static
 * lights enabled, the object lights alive, the scene's visible point-light
 * COUNT (it must not change, or every lit program recompiles) and the
 * renderer's program count.
 *
 * Output: verification/effects/<label>/ — frames `<ms>.jpg` and report.json.
 *
 * Usage (never on testacjs — Jake plays on it):
 *   AC_ACCOUNT=radarprobe AC_PASSWORD=radarprobe AC_BASE=http://localhost:3077/ \
 *     npx tsx tools/probe-effects.ts [--spell 1161 --target self|monster] [--label heal] [--ms 6000] [--gpu]
 *       [--create-char Name] (a fresh account: create a character on first login)
 * With no --spell it records Heal Self VI (1161, self) and Flame Bolt VI (85, a spawned drudge).
 * --teleloc '<@teleloc …>' moves there first (e.g. a dungeon cell, where object
 * lights pool: '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0');
 * --create WCID picks the monster (default 19257; 0 = none, target an existing --target-re match);
 * --pre '<@cmd>;…' runs admin commands first.
 * Compare the frames against the DAT expectation (docs/effects-verification.md):
 * the windup's hand swarm is blue additive sprites (0x06004438 / 0x06004D92).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

interface CastSpec { label: string; spellId: number; target: 'self' | 'monster' }
const casts: CastSpec[] = arg('spell')
  ? [{ label: arg('label') ?? `spell-${arg('spell')}`, spellId: Number(arg('spell')), target: (arg('target') as 'self' | 'monster') ?? 'self' }]
  : [{ label: 'heal-self-vi', spellId: 1161, target: 'self' }, { label: 'flame-bolt-vi', spellId: 85, target: 'monster' }];
const RECORD_MS = Number(arg('ms') ?? 6000);
/** Camera orbit: 'front' faces the caster (the hand glow), 'behind' follows the bolt to its target. */
const VIEW = arg('view') ?? 'front';

/** In-page instrumentation: wraps SpellEffects, the script player's hook sink, SOM.createObject. */
const HOOK = `(() => {
  const ac = window.__ac, fx = ac.spellEffects, som = ac.serverObjectManager;
  const rec = window.__fx = { t0: performance.now(), emitters: [], procedural: [], scripts: [], hooks: [], creates: [], sounds: [], lights: [] };
  const t = () => Math.round(performance.now() - rec.t0);
  const hex = (n) => '0x' + ((n >>> 0).toString(16));
  const proto = Object.getPrototypeOf(fx);
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (!/^(create|spawn)/.test(name) || typeof fx[name] !== 'function') continue;
    const orig = fx[name].bind(fx);
    fx[name] = (...args) => {
      if (name === 'spawnParticleEffect') {
        const [info, pos, , , sprite, , opts] = args;
        const me = ac.playerModel ? ac.playerModel.position : null;
        rec.emitters.push({ t: t(), emitter: hex(info.id), particleType: info.particleType, emitterType: info.emitterType,
          additive: !!(sprite && sprite.additive), textured: !!(sprite && sprite.map), part: opts && opts.partIndex !== undefined ? opts.partIndex : null,
          anchor: opts && opts.frameSource ? 'frame' : 'static',
          at: [pos.x, pos.y, pos.z].map((v) => +v.toFixed(2)), fromCaster: me ? +Math.hypot(pos.x - me.x, pos.z - me.z).toFixed(2) : null });
      } else if (name !== 'spawnParticleBurst' || !rec._inProc) {
        rec.procedural.push({ t: t(), fn: name });
      }
      rec._inProc = true;
      try { return orig(...args); } finally { rec._inProc = false; }
    };
  }
  const sp = ac.soundPlayer;
  const origPos = sp.playPositionalSound.bind(sp);
  sp.playPositionalSound = (wave, pos, listener, category, volume) => {
    rec.sounds.push({ t: t(), wave: hex(wave), dist: +Math.hypot(pos.x - listener.x, pos.y - listener.y, pos.z - listener.z).toFixed(1), volume: volume === undefined ? 1 : +(+volume).toFixed(2) });
    return origPos(wave, pos, listener, category, volume);
  };
  // Sampled AT EACH RENDER of the world scene (what three.js compiles against):
  // the visible point-light count must stay constant, and renderer.info's
  // program count shows any recompile.
  const budget = ac.datLightBudget, scene = ac.sceneManager.scene, renderer = ac.sceneManager.renderer;
  const origRender = renderer.render.bind(renderer);
  renderer.render = (sc, cam) => {
    if (sc === scene) {
      let visiblePoint = 0, objectLights = 0, objectLit = 0;
      scene.traverseVisible((o) => { if (o.isPointLight) visiblePoint++; });
      scene.traverse((o) => { if (o.userData && o.userData.datLightTracked) { objectLights++; if (o.visible) objectLit++; } });
      const c = budget.census();
      rec.lights.push({ t: t(), dynamicActive: c.dynamicActive, staticActive: c.staticActive, objectLights, objectLit, visiblePoint, programs: renderer.info.programs ? renderer.info.programs.length : -1 });
    }
    return origRender(sc, cam);
  };
  const origCreate = som.createObject.bind(som);
  som.createObject = (d) => { rec.creates.push({ t: t(), guid: hex(d.guid), name: d.name, setup: hex(d.setupId || 0), phys: hex(d.physicsState || 0) }); return origCreate(d); };
  const origLog = console.log.bind(console);
  console.log = (...a) => { const s = String(a[0]);
    if (/^\\[AC\\] (PlayScript|PlayEffect|PScript)/.test(s)) rec.scripts.push({ t: t(), line: s.slice(5, 140) });
    if (/^\\[AC\\] AnimHook/.test(s)) rec.hooks.push({ t: t(), line: s.slice(5, 160) });
    return origLog(...a); };
  return 'hooked';
})()`;

async function main(): Promise<void> {
  // --create-char <name>: a fresh account lands on character-create; make one.
  const s = await enterWorld({ cb: 'probe-effects', createCharacter: arg('create-char') });
  const page = s.page;
  // --console <regex>: echo matching page console lines (e.g. 'PlayEffect|HearSpeech').
  if (arg('console')) {
    const re = new RegExp(arg('console')!, 'i');
    page.on('console', (m) => { const x = m.text(); if (re.test(x)) console.log(`  [page] ${x.slice(0, 200)}`); });
  }
  await page.waitForTimeout(4000);
  console.log(await page.evaluate(HOOK));
  await adminCommand(page, '@god');
  await page.waitForTimeout(1500);
  if (arg('teleloc')) {
    await adminCommand(page, arg('teleloc')!);
    await page.waitForTimeout(20_000);
  }
  // --pre '<@cmd>;<@cmd>': extra admin commands before the casts (e.g.
  // '@create 22857' — a torch bowl whose Setup light pools in a dungeon).
  for (const cmd of (arg('pre') ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
    await adminCommand(page, cmd);
    await page.waitForTimeout(2500);
  }
  // --poi <name>: open ground (e.g. holtburg) so a bolt has room to fly.
  if (arg('poi')) {
    await adminCommand(page, `@telepoi ${arg('poi')}`);
    await page.waitForTimeout(20_000);
  }
  for (const c of casts) await adminCommand(page, `@addspell ${c.spellId}`);
  await page.waitForTimeout(1500);
  if (!(await page.evaluate('JSON.stringify([...(window.acDebug.equipped() || [])])') as string).includes('Practice Wand')) {
    await adminCommand(page, '@ci 4799');
    await page.waitForTimeout(2500);
  }
  await page.evaluate(`window.acDebug.equip('Practice Wand', 'Held')`);
  await page.waitForTimeout(3000);
  await page.evaluate(`window.acDebug.combatMode('magic')`);
  await page.waitForTimeout(3500);
  const me = await page.evaluate('window.__ac.charGuid') as number;

  for (const c of casts) {
    let target = me;
    if (c.target === 'monster') {
      // --create <wcid> (default 19257; 7089 = a Drudge; 0 = spawn nothing and
      // target an existing creature matching --target-re, default /drudge/).
      if (arg('create') !== '0') {
        await adminCommand(page, `@create ${arg('create') ?? '19257'}`);
        await page.waitForTimeout(3000);
      }
      const re = arg('target-re') ?? 'drudge';
      target = await page.evaluate(`(() => { const re = new RegExp(${JSON.stringify(re)}, 'i'); const o = [...window.__ac.serverObjectManager.objects.values()].filter((o) => re.test(o.name || '') && !/^corpse/i.test(o.name || ''))
        .sort((a, b) => Math.hypot(a.worldX - window.__ac.playerModel.position.x, a.worldZ - window.__ac.playerModel.position.z) - Math.hypot(b.worldX - window.__ac.playerModel.position.x, b.worldZ - window.__ac.playerModel.position.z))[0]; return o ? o.guid : 0; })()`) as number;
      if (!target) { console.log(`${c.label}: no /${re}/ target — skipped`); continue; }
      await page.evaluate(`window.acDebug.select(${target})`);
      await page.waitForTimeout(500);
      // @create drops the monster at the caster's feet; back away so the
      // bolt has room to fly (--backup-ms, default 1500; 0 to stay put).
      const backupMs = Number(arg('backup-ms') ?? 1500);
      if (backupMs > 0) {
        await page.keyboard.down('ArrowDown');
        await page.waitForTimeout(backupMs);
        await page.keyboard.up('ArrowDown');
        await page.waitForTimeout(800);
      }
    }
    // Face the caster (the hands and the chest-front swarm are hidden from behind),
    // or stay behind to follow a bolt. Frame names and report times share one
    // origin; the cast is sent ~1000 ms in.
    await page.evaluate(`window.__ac.cameraController.cameraYawOffset = ${VIEW === 'behind' ? 0 : 'Math.PI * 0.85'}`);
    // --zoom N: CameraSet zoom notches (positive = farther) for a wider view.
    if (arg('zoom')) await page.evaluate(`window.__ac.cameraController.zoomBy(${Number(arg('zoom'))})`);
    await page.waitForTimeout(800);
    await page.evaluate('Object.assign(window.__fx, { t0: performance.now(), emitters: [], procedural: [], scripts: [], hooks: [], creates: [], sounds: [], lights: [] })');

    const out = `verification/effects/${c.label}`;
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const cdp = await page.context().newCDPSession(page);
    const frames: { ms: number; data: string }[] = [];
    const t0 = Date.now();
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
      frames.push({ ms: Date.now() - t0, data: f.data });
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
    await page.waitForTimeout(1000); // the stream takes ~1 s to deliver its first frame
    // The spell bar's own cast path (gameUI → onCastSpell), the one a player's click takes.
    const idx = await page.evaluate(`window.__ac.magicController.knownSpells.findIndex((s) => s.id === ${c.spellId})`) as number;
    await page.evaluate(`window.__ac.gameUI.spellCallbacks.onCastSpell(${idx})`);
    await page.waitForTimeout(RECORD_MS);
    await cdp.send('Page.stopScreencast');
    for (const f of frames) writeFileSync(`${out}/${String(f.ms).padStart(5, '0')}.jpg`, Buffer.from(f.data, 'base64'));
    const rec = JSON.parse(await page.evaluate('JSON.stringify(window.__fx)') as string);
    delete rec._inProc;
    // Render stalls: screencast gaps over 250 ms (a shader compile, a light-count
    // change recompiling every lit program, a texture upload, …).
    const stalls: { at: number; ms: number }[] = [];
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i].ms - frames[i - 1].ms;
      if (gap > 250) stalls.push({ at: frames[i - 1].ms, ms: gap });
    }
    writeFileSync(`${out}/report.json`, JSON.stringify({ cast: c, frames: frames.length, stalls, ...rec }, null, 2));
    console.log(`=== ${c.label}: ${frames.length} frames → ${out}`);
    console.log(`  render stalls > 250 ms: ${stalls.length ? stalls.map((s) => `${s.ms} ms @${s.at}`).join(', ') : 'none'}`);
    console.log(`  procedural (client-invented) effects: ${rec.procedural.length ? rec.procedural.map((p: { t: number; fn: string }) => `${p.fn}@${p.t}`).join(' ') : 'none'}`);
    const byEmitter = new Map<string, number>();
    for (const e of rec.emitters) byEmitter.set(`${e.emitter}${e.part !== null ? `@part${e.part}` : ''}${e.additive ? ' add' : ''}`, (byEmitter.get(`${e.emitter}${e.part !== null ? `@part${e.part}` : ''}${e.additive ? ' add' : ''}`) ?? 0) + 1);
    console.log(`  DAT emitters: ${[...byEmitter].map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}`);
    for (const x of rec.scripts) console.log(`  t=${x.t} ${x.line}`);
    for (const x of rec.creates) console.log(`  t=${x.t} CreateObject ${x.guid} "${x.name}" setup=${x.setup} phys=${x.phys}`);
    const lit = rec.lights.filter((l: { objectLit: number }) => l.objectLit > 0);
    const counts = new Set(rec.lights.map((l: { visiblePoint: number }) => l.visiblePoint));
    console.log(`  object lights: ${lit.length ? `lit ${lit[0].t}–${lit[lit.length - 1].t} ms (max ${Math.max(...lit.map((l: { objectLit: number }) => l.objectLit))})` : 'none lit'}; `
      + `visible point-light counts seen: ${[...counts].join(', ')}; lit programs ${rec.lights.length ? `${rec.lights[0].programs} → ${rec.lights[rec.lights.length - 1].programs}` : '?'}`);
    console.log(`  positional sounds: ${rec.sounds.length ? rec.sounds.map((x: { t: number; wave: string; dist: number }) => `${x.wave}@${x.t} (${x.dist} m)`).join(' ') : 'none'}`);
    await page.evaluate('window.__ac.cameraController.cameraYawOffset = 0');
    await page.waitForTimeout(2500);
  }
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
