/**
 * probe-dungeon-overbright — VISUAL.dungeon-intermittent-overbright.
 *
 * Teleports into a sealed dungeon drop point (default: Nuhmudira's, the
 * retail-ab tour teleloc) and samples, every ~300 ms for --seconds after the
 * teleport command, the world brightness (mean sRGB of two wall boxes) and
 * the lighting state behind it: the scene ambient lights, the sealed flag,
 * the sun, and every lit point light (colour, intensity, decay class,
 * range, distance from the player). Frames are saved so the bright and the
 * steady state can be compared.
 *
 * Usage: npx tsx tools/probe-dungeon-overbright.ts [--out verification/dungeon-lighting/overbright]
 *          [--teleloc '<cell [x y z] qw qx qy qz>'] [--seconds 20] [--gpu]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { enterWorld, teleloc, sessionArgs } from './lib/game-session.js';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = arg('out') ?? 'verification/dungeon-lighting/overbright';
const DUNGEON = arg('teleloc') ?? '0x536D0289 [149.243 -129.946 -5.995] -0.7071 0 0 -0.7071';
const SECONDS = Number(arg('seconds') ?? 20);
const PRE = arg('pre');
/** --frames: after arrival, record EVERY rendered frame for --seconds (one wall pixel + the light state). */
const FRAMES = argv.includes('--frames');
// --hide-particles (with --frames): hide every particle mesh before each draw (control run).

/** Wraps renderer.render: after each draw, read one wall pixel and summarise the lights three.js will use. */
const FRAME_HOOK = `(() => {
  const HIDE_PARTICLES = ${argv.includes('--hide-particles')};
  const ac = window.__ac, r = ac.sceneManager.renderer, scene = ac.sceneManager.scene, gl = r.getContext();
  const rec = window.__ob = { frames: [] };
  const px = new Uint8Array(4);
  /** 1600x900 points: left wall, right wall, near floor left/right, the gate, the ceiling. */
  const SAMPLE_POINTS = [[250, 170], [1350, 170], [300, 750], [1300, 750], [800, 300], [800, 30]];
  const orig = r.render.bind(r);
  r.render = (s, c) => {
    let particles = 0;
    if (s === scene) s.traverse((o) => { if (o.name && o.name.startsWith('particle')) { if (HIDE_PARTICLES) o.visible = false; else if (o.visible) particles++; } });
    orig(s, c);
    if (s !== scene) return;
    const H = gl.drawingBufferHeight, W = gl.drawingBufferWidth, pts = [];
    for (const [x, y] of SAMPLE_POINTS) { gl.readPixels(Math.round(x * W / 1600), H - Math.round(y * H / 900), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); pts.push([px[0], px[1], px[2]]); }
    px[0] = pts[0][0]; px[1] = pts[0][1]; px[2] = pts[0][2];
    let n = 0, mag = 0, magI = 0, amb = 0; const magPos = [];
    s.traverseVisible((o) => {
      if (o.isPointLight) { n++; if (o.intensity > 0 && o.color.g < 0.1 && o.color.r > 0.5) { mag++; magI += o.intensity; const p = o.getWorldPosition(new (s.position.constructor)()); magPos.push([+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +o.distance.toFixed(2), +o.decay.toFixed(2)]); } }
      else if (o.isAmbientLight) amb += o.intensity;
    });
    const info = r.info.render;
    rec.frames.push({ t: Math.round(performance.now()), particles, px: [px[0], px[1], px[2]], pts, n, mag, magI, magPos, amb: +amb.toFixed(3), programs: r.info.programs ? r.info.programs.length : -1, calls: info.calls });
  };
  return 'hooked';
})()`;

/** Boxes in a 1600x900 frame (the metrics.json regions). */
const BOXES = { leftWallTop: [100, 110, 400, 120], rightWallTop: [1100, 110, 400, 120], floorNearR: [1000, 700, 250, 80] } as const;

const STATE = `(() => {
  const ac = window.__ac, scene = ac.sceneManager.scene;
  const cs = window.acDebug.collisionState();
  const player = new (scene.position.constructor)();
  const pm = ac.playerModel || null;
  if (pm) pm.getWorldPosition(player);
  const amb = [], dirs = [], points = [];
  scene.traverseVisible((o) => {
    if (o.isAmbientLight) amb.push({ c: o.color.getHexString(), i: +o.intensity.toFixed(3) });
    else if (o.isDirectionalLight) dirs.push({ c: o.color.getHexString(), i: +o.intensity.toFixed(3) });
    else if (o.isPointLight && o.intensity > 0) {
      const p = new (scene.position.constructor)(); o.getWorldPosition(p);
      let owner = ''; for (let q = o.parent; q; q = q.parent) { if (q.owner && q.owner.name) { owner = q.owner.name; break; } if (q.name && q !== scene) { owner = q.name; } }
      points.push({ c: o.color.getHexString(), i: +o.intensity.toFixed(2), decay: +o.decay.toFixed(2), range: +o.distance.toFixed(2), d: +p.distanceTo(player).toFixed(2), owner, dyn: !!o.userData.datLightDynamic, tracked: !!o.userData.datLightTracked });
    }
  });
  points.sort((a, b) => a.d - b.d);
  return { cell: '0x' + ((cs && cs.cellId) >>> 0).toString(16), sealed: ac.skybox ? ac.skybox.isSealedInterior : null, amb, dirs, nPoints: points.length, points: points.slice(0, 12), census: ac.datLightBudget ? ac.datLightBudget.census() : null };
})()`;

function boxMeans(png: Buffer): Record<string, number[]> {
  const img = PNG.sync.read(png);
  const out: Record<string, number[]> = {};
  for (const [k, [x0, y0, w, h]] of Object.entries(BOXES)) {
    const s = [0, 0, 0]; let n = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * 4; s[0] += img.data[i]; s[1] += img.data[i + 1]; s[2] += img.data[i + 2]; n++;
    }
    out[k] = s.map((v) => Math.round(v / n));
  }
  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { browser, page } = await enterWorld({ ...sessionArgs(), viewport: { width: 1600, height: 900 }, createCharacter: 'Overbright Probe', settleMs: 8000 } as never);
  const samples: unknown[] = [];
  try {
    if (PRE) await teleloc(page, PRE, 15_000);
    const t0 = Date.now();
    await teleloc(page, DUNGEON, 0);
    if (FRAMES) {
      await page.waitForTimeout(12_000);
      await page.evaluate(FRAME_HOOK);
      await page.waitForTimeout(SECONDS * 1000);
      const frames = await page.evaluate('window.__ob.frames') as { px: number[] }[];
      writeFileSync(`${OUT}/frames.json`, JSON.stringify(frames));
      const med = [...frames].map((f) => f.px[0] + f.px[2]).sort((a, b) => a - b)[frames.length >> 1];
      const odd = frames.filter((f) => Math.abs(f.px[0] + f.px[2] - med) > 20);
      console.log(`frames ${frames.length}, median R+B ${med}, outliers ${odd.length}`);
      for (const f of odd.slice(0, 20)) console.log(JSON.stringify(f));
      const i = frames.indexOf(odd[0] as never);
      if (i > 0) console.log('before:', JSON.stringify(frames[i - 1]));
      return;
    }
    let k = 0;
    while (Date.now() - t0 < SECONDS * 1000) {
      const t = Date.now() - t0;
      const shot = await page.screenshot();
      const state = await page.evaluate(STATE).catch((e) => ({ error: String(e) }));
      const means = boxMeans(shot);
      const name = `f${String(k).padStart(3, '0')}-${t}ms.png`;
      writeFileSync(`${OUT}/${name}`, shot);
      samples.push({ t, name, means, state });
      console.log(t, JSON.stringify(means), JSON.stringify((state as { sealed?: unknown }).sealed), JSON.stringify((state as { amb?: unknown }).amb), JSON.stringify(((state as { points?: unknown[] }).points ?? []).slice(0, 3)));
      k++;
      await page.waitForTimeout(300);
    }
  } finally {
    writeFileSync(`${OUT}/samples.json`, JSON.stringify(samples, null, 1));
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
