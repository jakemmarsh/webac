/**
 * probe-object-lights-sounds — live check for BUG.server-object-setup-lights
 * and BUG.remote-anim-sound-hooks.
 *
 * In a dungeon cell (object lights only pool from env cells) it:
 *  1. creates a Tiki Torch (wcid 22857, setup 0x020009A3 — LightsStatus true,
 *     one Setup LightInfo) and reports its PhysicsState, the PointLights built
 *     for it, whether the pool enabled them, and the scene's visible
 *     point-light COUNT and the renderer's program count before/after (neither
 *     may change — a light-count change recompiles every lit program), plus
 *     the rAF frame gaps before / after the create (noisy on a loaded host);
 *  2. screenshots the scene with the torch's light on and forced off;
 *  3. creates a creature (--creature WCID, default 7089 Drudge) and records
 *     every positional sound started for 12 s (wave, the object it came from,
 *     distance, volume) — the creatures' own animation sound hooks.
 * The Flame Bolt's own light is checked by tools/probe-effects.ts (its
 * per-render light sampler), e.g. in the Training Academy:
 *   … probe-effects.ts --gpu --spell 85 --target monster --create 0 --target-re 'young olthoi'
 *     --teleloc '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0' --view behind --backup-ms 0
 *
 * Usage (own account — never testacjs / testacjs2):
 *   AC_ACCOUNT=fxprobe2 AC_PASSWORD=fxprobe2 AC_BASE=http://localhost:3091/ \
 *     npx tsx tools/probe-object-lights-sounds.ts [--gpu] [--creature 7089] [--out verification/effects/object-lights]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { enterWorld, adminCommand, readAc } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = arg('out') ?? 'verification/effects/object-lights';
const DUNGEON = arg('teleloc') ?? '@teleloc 0x86020115 [190 -240 -11.5] 1 0 0 0';

/** In-page recorders: positional sounds, rAF frame gaps, light pool samples. */
const HOOK = `(() => {
  const ac = window.__ac;
  const rec = window.__ols = { t0: performance.now(), sounds: [], frames: [], lights: [] };
  const t = () => Math.round(performance.now() - rec.t0);
  const sp = ac.soundPlayer, orig = sp.playPositionalSound.bind(sp);
  sp.playPositionalSound = (wave, pos, listener, category, volume) => {
    let near = null, best = Infinity;
    for (const o of ac.serverObjectManager.getAllObjects().values()) {
      const d = Math.hypot(o.worldX - pos.x, o.worldZ - pos.z);
      if (d < best) { best = d; near = o.name; }
    }
    rec.sounds.push({ t: t(), wave: '0x' + (wave >>> 0).toString(16), from: best < 1.5 ? near : 'player/other',
      dist: +Math.hypot(pos.x - listener.x, pos.y - listener.y, pos.z - listener.z).toFixed(1), volume: volume === undefined ? 1 : +(+volume).toFixed(2) });
    return orig(wave, pos, listener, category, volume);
  };
  let last = performance.now();
  const tick = (now) => { rec.frames.push({ t: Math.round(now - rec.t0), dt: +(now - last).toFixed(1) }); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return 'hooked';
})()`;

const LIGHT_STATE = `(() => {
  const ac = window.__ac, scene = ac.sceneManager.scene;
  let visiblePoint = 0; scene.traverseVisible((o) => { if (o.isPointLight) visiblePoint++; });
  const objs = [];
  for (const o of ac.serverObjectManager.getAllObjects().values()) {
    if (!o.mesh) continue;
    // Object lights hang off a carrier at the scene root (BUG.hidden-object-lights-leave-pool).
    const lights = []; o.mesh.traverse((c) => { if (c.userData && c.userData.datLightTracked) lights.push(c); });
    for (const c of scene.children) if (c.name === 'object-light-carrier' && c.owner === o.mesh) lights.push(...c.children);
    if (!lights.length) continue;
    objs.push({ name: o.name, guid: '0x' + o.guid.toString(16), setup: '0x' + o.setupId.toString(16), phys: '0x' + (o.physicsState >>> 0).toString(16), cell: '0x' + o.cellId.toString(16),
      lights: lights.map((l) => ({ lit: l.visible, color: l.color.getHexString(), intensity: l.intensity, range: +l.distance.toFixed(2), decay: l.decay })) });
  }
  const r = ac.sceneManager.renderer;
  return { census: ac.datLightBudget.census(), visiblePoint, programs: r && r.info.programs ? r.info.programs.length : -1, objs };
})()`;

async function maxGap(page: import('playwright').Page, fromMs: number, toMs: number): Promise<{ max: number; n: number; mean: number }> {
  return page.evaluate(`(() => { const f = window.__ols.frames.filter((x) => x.t >= ${fromMs} && x.t < ${toMs});
    return { max: Math.max(0, ...f.map((x) => x.dt)), n: f.length, mean: f.length ? +(f.reduce((a, x) => a + x.dt, 0) / f.length).toFixed(1) : 0 }; })()`) as never;
}
const now = (page: import('playwright').Page): Promise<number> => page.evaluate('Math.round(performance.now() - window.__ols.t0)') as Promise<number>;
/** Wait until the page has rendered `n` more frames (a loaded machine can run a few fps; state is only current after frames). */
async function waitFrames(page: import('playwright').Page, n: number, capMs = 60_000): Promise<void> {
  const start = await page.evaluate('window.__ols.frames.length') as number;
  const t0 = Date.now();
  while (Date.now() - t0 < capMs && ((await page.evaluate('window.__ols.frames.length') as number) - start) < n) await page.waitForTimeout(250);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ cb: 'probe-object-lights' } as never);
  const page = s.page;
  const report: Record<string, unknown> = {};
  await page.waitForTimeout(3000);
  await adminCommand(page, DUNGEON);
  await page.waitForTimeout(20_000);
  console.log(await page.evaluate(HOOK));
  // Audio starts on the first document click (main.ts initAudio).
  await page.mouse.click(4, 300);
  await page.waitForTimeout(1000);
  console.log('audio context:', await page.evaluate('String(window.__ac.audioManager.audioContext && window.__ac.audioManager.audioContext.state)'));

  // 1. Tiki Torch.
  const before = await page.evaluate(LIGHT_STATE) as { visiblePoint: number; programs: number };
  await page.waitForTimeout(3000);
  const tCreate = await now(page);
  await adminCommand(page, '@create 22857');
  await page.waitForTimeout(3500);
  await waitFrames(page, 30);
  const after = await page.evaluate(LIGHT_STATE) as { visiblePoint: number; programs: number; objs: unknown[]; census: unknown };
  const gapBefore = await maxGap(page, tCreate - 3000, tCreate);
  const gapAfter = await maxGap(page, tCreate, await now(page));
  report.torch = { before, after, frameGapBefore: gapBefore, frameGapAfter: gapAfter };
  console.log('torch: visible point lights', before.visiblePoint, '→', after.visiblePoint, '; programs', before.programs, '→', after.programs);
  console.log('torch: lit objects', JSON.stringify(after.objs));
  console.log('torch: frame gap before', JSON.stringify(gapBefore), 'after create', JSON.stringify(gapAfter));

  // 2. Screenshots: the torch's light on, then forced off (the budget re-enables it next frame, so hide the light's parent pool entry).
  await readAc(page, `ac.cameraController.cameraYawOffset = Math.PI`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/torch-light-on.jpg`, type: 'jpeg', quality: 80 });
  await page.evaluate(`(() => { const ac = window.__ac; ac.datLightBudget.capsOverride = { maxStaticLights: 40, maxDynamicLights: 0 }; })()`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/torch-light-off.jpg`, type: 'jpeg', quality: 80 });
  await page.evaluate(`window.__ac.datLightBudget.capsOverride = null`);
  await readAc(page, `ac.cameraController.cameraYawOffset = 0`);

  // 3. A drudge: its animation sound hooks.
  await page.evaluate('window.__ols.sounds = []');
  await adminCommand(page, `@create ${arg('creature') ?? '7089'}`);
  await page.waitForTimeout(12_000);
  await waitFrames(page, 120);
  const sounds = await page.evaluate('window.__ols.sounds') as Array<{ from: string; wave: string; dist: number }>;
  report.drudgeSounds = sounds;
  const bySource = new Map<string, number>();
  for (const x of sounds) bySource.set(x.from, (bySource.get(x.from) ?? 0) + 1);
  console.log(`sounds in 12 s: ${sounds.length}; by source: ${[...bySource].map(([k, n]) => `${k}×${n}`).join(', ')}`);
  for (const x of sounds.slice(0, 30)) console.log('  ', JSON.stringify(x));

  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await s.browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
