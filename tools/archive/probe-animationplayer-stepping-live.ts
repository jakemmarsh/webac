/**
 * BUG.animationplayer-loop-period-off-by-one-frame — live probe of the world
 * animation player on the ACE stack at Holtburg, on the REAL GPU (headless
 * Chromium with ANGLE Metal — SwiftShader's ~0.4 fps cannot show a walk
 * cycle).
 *
 * Logs in, @telepoi holtburg, noon; then per rendered frame records every
 * AnimatedEntity's player state (the local player + the creatures / NPCs in
 * view): animation id, frame number, rate, and whether the parts carry
 * EXACTLY the keyframe floor(frame) (stepped) or a blend. Legs: idle 3 s,
 * W 4 s, Shift+W 4 s, idle (+TestChar has RunAsDefault off — its
 * character_options_1 is 0 — so W walks and Shift+W runs). Measures per loop: the observed
 * period (time between wraps) vs N / |rate| (retail) and (N − 1) / |rate|
 * (the old player); whether the last keyframe is ever shown. Screenshot
 * strips of both legs (third-person camera).
 *
 *   npx tsx tools/probe-animationplayer-stepping-live.ts [label]
 *   npx tsx tools/probe-animationplayer-stepping-live.ts --compose   (before | after sheet)
 *
 * `label` names the output subfolder (default "after") so a before-run on
 * the old player can sit next to it: verification/bug-animationplayer-stepping/<label>/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const LABEL = process.argv[2] ?? 'after';
const OUT = join(__dir, '..', 'verification', 'bug-animationplayer-stepping', LABEL);
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=animstep';
const VIEW = { width: 1280, height: 800 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  }).catch(() => false);
}

/** Installs a per-rAF recorder over every animated entity; `window.__animRec` collects rows. */
const RECORDER_JS = `(() => {
  const ac = window.__ac;
  const som = ac.serverObjectManager;
  window.__animRec = { rows: [], on: true, leg: 'idle' };
  const rec = window.__animRec;
  const tick = () => {
    if (!rec.on) return;
    const now = performance.now() / 1000;
    const player = som.localPlayerGuid;
    for (const [guid, ent] of som.animatedObjects) {
      const mm = ent.motionManager; if (!mm) continue;
      const p = mm.animationPlayer; const a = p.currentAnimation; if (!a) continue;
      const idx = typeof p.currentFrameIndex === 'number' ? p.currentFrameIndex : Math.floor(p.currentFrame + p.lowFrame);
      // stepped iff the parts carry exactly partFrames[idx]
      const tf = p.getPartTransforms();
      const kf = a.partFrames[idx] ? a.partFrames[idx].frames : null;
      let stepped = !!kf && tf.length === kf.length;
      if (stepped) for (let i = 0; i < tf.length; i++) { const q = tf[i], k = kf[i]; if (Math.abs(q.origin.x - k.origin.x) > 1e-7 || Math.abs(q.origin.y - k.origin.y) > 1e-7 || Math.abs(q.origin.z - k.origin.z) > 1e-7 || Math.abs(q.orientation.w - k.orientation.w) > 1e-7) { stepped = false; break; } }
      rec.rows.push({ t: now, leg: rec.leg, guid, player: guid === player, anim: a.id, n: a.numFrames, low: p.lowFrame, high: p.highFrame, fr: p.framerate, speed: p.speed, loop: p.looping, playing: p.isPlaying, frame: p.currentFrame, idx, stepped });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return som.animatedObjects.size;
})()`;

interface Row { t: number; leg: string; guid: number; player: boolean; anim: number; n: number; low: number; high: number; fr: number; speed: number; loop: boolean; playing: boolean; frame: number; idx: number; stepped: boolean }

function analyse(rows: Row[]): { loops: Record<string, unknown>[] } {
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.leg}|${r.guid}|${r.anim}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const out: Record<string, unknown>[] = [];
  for (const [k, rs] of byKey) {
    if (rs.length < 4) continue;
    const [leg, guid, anim] = k.split('|');
    const r0 = rs[0];
    const span = r0.high - r0.low + 1;
    const rate = Math.abs(r0.fr * r0.speed);
    // wraps: the frame position drops (forward) — time between consecutive wraps is one period
    const wraps: number[] = [];
    for (let i = 1; i < rs.length; i++) {
      const fwd = r0.fr * r0.speed >= 0;
      if (fwd ? rs[i].frame < rs[i - 1].frame - 0.5 : rs[i].frame > rs[i - 1].frame + 0.5) {
        // interpolate the wrap instant from the advance rate: t_wrap = t_i − frame_i / rate
        const into = fwd ? rs[i].frame : (span - rs[i].frame);
        wraps.push(rs[i].t - into / rate);
      }
    }
    const periods = wraps.slice(1).map((w, i) => w - wraps[i]);
    const idxSeen = new Set(rs.map((r) => r.idx));
    out.push({
      leg, guid: '0x' + (+guid >>> 0).toString(16), player: r0.player, anim: '0x' + (+anim >>> 0).toString(16), frames: span, rate: +rate.toFixed(3), loop: r0.loop,
      samples: rs.length, allStepped: rs.every((r) => r.stepped), steppedShare: +(rs.filter((r) => r.stepped).length / rs.length).toFixed(3),
      lastFrameSeen: idxSeen.has(r0.high), distinctFrames: idxSeen.size,
      measuredPeriods: periods.map((p) => +p.toFixed(4)),
      retailPeriod: rate ? +(span / rate).toFixed(4) : null, oldPeriod: rate ? +((span - 1) / rate).toFixed(4) : null,
    });
  }
  return { loops: out };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g?.getExtension('WEBGL_debug_renderer_info'); return e ? g!.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
  console.log(`[animstep] GPU: ${gpu}`);
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline && !(await inWorld(page))) {
    if (Date.now() - lastReload > 60_000) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
  await page.waitForTimeout(8000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(6000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(3000);
  const ents = await page.evaluate(RECORDER_JS);
  console.log(`[animstep] recording ${ents} animated entities`);
  const leg = (name: string) => page.evaluate((n) => { (window as any).__animRec.leg = n; }, name);
  const fps0 = await page.evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); })`) as number;
  console.log(`[animstep] fps ≈ ${fps0}`);

  await leg('idle');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT, 'idle.png') });

  await leg('w'); // W: TestChar walks by default (character_options_1 = 0 — RunAsDefault off), so this leg is WalkForward
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i++) { await page.screenshot({ path: join(OUT, `w-${i}.png`) }); await page.waitForTimeout(350); }
  await page.waitForTimeout(1200);
  await page.keyboard.up('w');
  await leg('stop-w');
  await page.waitForTimeout(1500);

  await leg('shift-w'); // Shift+W: RunForward at the run rate
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  for (let i = 0; i < 4; i++) { await page.screenshot({ path: join(OUT, `shift-w-${i}.png`) }); await page.waitForTimeout(350); }
  await page.waitForTimeout(1200);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  await leg('idle-2');
  await page.waitForTimeout(3000);

  const rows = await page.evaluate(() => { const r = (window as any).__animRec; r.on = false; return r.rows; }) as Row[];
  const result = { label: LABEL, gpu, fps: fps0, capturedAt: new Date().toISOString(), rowCount: rows.length, ...analyse(rows) };
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify(result, null, 2));
  for (const l of (result.loops as Record<string, unknown>[]).filter((x) => x.player || (x.measuredPeriods as number[]).length > 0)) {
    console.log(`[animstep] ${l.leg} ${l.player ? 'PLAYER' : l.guid} anim ${l.anim} n=${l.frames} rate=${l.rate} stepped=${l.allStepped}(${l.steppedShare}) lastSeen=${l.lastFrameSeen} periods=${JSON.stringify(l.measuredPeriods)} retail=${l.retailPeriod} old=${l.oldPeriod}`);
  }
  await browser.close();
}

/** before | after sheet: the player's loops (measured period vs N/rate and (N−1)/rate, stepped, last frame seen) and the two legs' shot strips. */
async function compose(): Promise<void> {
  const root = join(__dir, '..', 'verification', 'bug-animationplayer-stepping');
  const load = (lab: string) => JSON.parse(readFileSync(join(root, lab, 'probe.json'), 'utf8'));
  const runs = ['before', 'after'].filter((l) => existsSync(join(root, l, 'probe.json'))).map((l) => ({ lab: l, r: load(l) }));
  const img = (lab: string, f: string) => existsSync(join(root, lab, f))
    ? `<div class="crop"><img src="data:image/png;base64,${readFileSync(join(root, lab, f)).toString('base64')}"/></div>` : '';
  const rows = runs.map(({ lab, r }) => {
    const loops = (r.loops as Record<string, any>[]).filter((l) => l.player && l.measuredPeriods.length);
    const all = r.loops as Record<string, any>[];
    const dev: number[] = [];
    for (const l of all) for (const p of l.measuredPeriods) if (l.retailPeriod && l.frames > 1) dev.push(Math.abs(p - l.retailPeriod) / l.retailPeriod);
    dev.sort((a, b) => a - b);
    return `<h2>${lab} — ${all.length} entity loops · stepped ${all.filter((l) => l.allStepped).length} · last keyframe seen ${all.filter((l) => l.lastFrameSeen).length} · median |period − N/rate| / (N/rate) = ${(dev[dev.length >> 1] * 100).toFixed(2)}%</h2>
      <table><tr><th>leg</th><th>anim</th><th>N</th><th>rate</th><th>measured periods (s)</th><th>N/rate (retail)</th><th>(N−1)/rate (old)</th><th>stepped</th><th>last frame seen</th></tr>
      ${loops.map((l) => `<tr><td>${l.leg}</td><td>${l.anim}</td><td>${l.frames}</td><td>${l.rate}</td><td>${l.measuredPeriods.join(', ')}</td><td>${l.retailPeriod}</td><td>${l.oldPeriod}</td><td>${l.allStepped}</td><td>${l.lastFrameSeen}</td></tr>`).join('')}</table>
      <div class="row">${[0, 1, 2, 3].map((i) => img(lab, `w-${i}.png`)).join('')}</div>
      <div class="row">${[0, 1, 2, 3].map((i) => img(lab, `shift-w-${i}.png`)).join('')}</div>`;
  }).join('');
  const html = `<style>body{background:#1a1a1a;color:#eee;font:12px monospace;padding:10px;margin:0}table{border-collapse:collapse;margin:6px 0}td,th{border:1px solid #555;padding:2px 6px}h1{font-size:13px}h2{font-size:12px;color:#9cf;margin-top:14px}.row{display:flex;gap:6px;margin-top:6px}.crop{width:300px;height:300px;overflow:hidden;position:relative;border:1px solid #444}.crop img{position:absolute;left:-490px;top:-300px}</style>
    <h1>BUG.animationplayer-loop-period-off-by-one-frame — the world animation player at Holtburg (ACE stack, real GPU ANGLE Metal, ~120 fps). Retail CSequence: whole keyframes, each 1/rate, period N/rate. Rows: +TestChar (W walks, Shift+W runs); strips: W then Shift+W, 350 ms apart.</h1>${rows}`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(root, 'animationplayer-stepping-before-after.png'), fullPage: true });
  await browser.close();
  console.log(`[animstep] wrote ${join(root, 'animationplayer-stepping-before-after.png')}`);
}

(process.argv.includes('--compose') ? compose() : main()).catch((e) => { console.error(e); process.exit(1); });
