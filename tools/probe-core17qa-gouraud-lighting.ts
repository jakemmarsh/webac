/**
 * CORE.17.q.a diagnostic — the per-vertex (Gouraud) retail light path. Lands
 * at the Holtburg Dungeon drop point (world DB portalholtburgdungeon →
 * 0x01F60289 (96.7, -10, 0), the tan cobble set of rawg_04 / rawg_09), pins
 * noon, records every WebGL / shader console error (a broken GLSL patch is
 * the failure mode here), then samples region means as-is / with the sky
 * ambient hidden + viewer light off (what the DAT torches alone light) / with
 * the DAT torches off, and dumps a luminance histogram of the world area:
 * per-fragment saturation gave the torch-lit walls ONE brightness (texel);
 * per-vertex interpolation gives a spread (the pools). Also captures the
 * Holtburg outdoor frame for the landscape / object side.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const OUT = process.env.OUT ?? '/home/user/acjs/verification/core17qa';
const TAG = process.env.TAG ?? 'after';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=qa' + Date.now();
const TELEPORT = '@teleloc 0x01F60289 [96.7 -10 0] -0.719 0 0 -0.695';
async function inWorld(page: Page) { return page.evaluate(() => { const cs = (window as any).acDebug?.collisionState?.(); return !!(cs && cs.x > 0); }); }
async function stats(page: Page, box: [number, number, number, number]) {
  const buf = await page.screenshot({ clip: { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] } });
  return page.evaluate(async (b64) => { const im = new Image(); await new Promise((r) => { im.onload = r; im.src = 'data:image/png;base64,' + b64; }); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const ctx = c.getContext('2d')!; ctx.drawImage(im, 0, 0); const d = ctx.getImageData(0, 0, c.width, c.height).data; let r = 0, g = 0, b = 0; const n = d.length / 4; const hist = new Array(16).fill(0); for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; hist[Math.min(15, Math.floor(l / 16))]++; } return { mean: [Math.round(r / n), Math.round(g / n), Math.round(b / n)], hist: hist.map((h: number) => +(h / n).toFixed(4)) }; }, buf.toString('base64'));
}
async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}) });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000); page.on('dialog', (d) => void d.dismiss());
  const glErrors: string[] = [];
  page.on('console', (m) => { const t = m.text(); if (/shader|glsl|WebGL|THREE\.WebGLProgram|compile|link/i.test(t) && /error|fail|invalid/i.test(t)) glErrors.push(t.slice(0, 2000)); });
  page.on('pageerror', (e) => glErrors.push('pageerror: ' + String(e).slice(0, 500)));
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (Date.now() < deadline) { if (await inWorld(page)) break; if (Date.now() - lastReload > 60_000) { try { await page.reload({ waitUntil: 'domcontentloaded' }); } catch {} lastReload = Date.now(); } await page.waitForTimeout(3000); }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(6000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${OUT}/${TAG}-holtburg-noon.png` });
  const BOXES: Record<string, [number, number, number, number]> = { feet: [640, 600, 930, 700], leftWall: [80, 200, 380, 420], rightWall: [1180, 200, 1480, 420], farCentre: [640, 250, 930, 420], floorLeft: [300, 600, 600, 700], world: [0, 40, 1568, 560] };
  const results: Record<string, Record<string, unknown>> = {};
  const outdoor: Record<string, unknown> = {}; for (const [k, b] of Object.entries(BOXES)) outdoor[k] = await stats(page, b); results.holtburg_noon = outdoor;
  console.log('holtburg_noon', JSON.stringify(outdoor));
  const r = await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), TELEPORT);
  console.log('teleloc:', JSON.stringify(r));
  await page.waitForTimeout(5000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(12000);
  const where = await page.evaluate(() => { const d = (window as any).acDebug; return { cs: d?.collisionState?.(), cell: d?.currentCell?.() ?? d?.playerCell?.() }; });
  const lights = await page.evaluate(() => { let n = 0, vis = 0, tagged = 0; (window as any).__ac.sceneManager.scene.traverse((o: any) => { if (o.isPointLight && o.userData.datLight) { n++; if (o.visible) vis++; if (o.decay < 0) tagged++; } }); return { datPointLights: n, visible: vis, staticTagged: tagged }; });
  console.log('where:', JSON.stringify(where), 'lights:', JSON.stringify(lights));
  const step = async (label: string, js: string, shot?: string) => { await page.evaluate(js); await page.waitForTimeout(8000); const m: Record<string, unknown> = {}; for (const [k, b] of Object.entries(BOXES)) m[k] = await stats(page, b); results[label] = m; console.log(label, JSON.stringify(m)); if (shot) await page.screenshot({ path: `${OUT}/${TAG}-${shot}.png` }); };
  await step('dungeon_noon', '0', 'dungeon-yaw0');
  for (const [name, yaw] of [['yaw1', 1.6], ['yaw2', 3.2], ['yaw3', 4.8]] as [string, number][]) { await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), yaw); await page.waitForTimeout(2500); await page.screenshot({ path: `${OUT}/${TAG}-dungeon-${name}.png` }); }
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0); await page.waitForTimeout(2000);
  await step('dungeon_torchesOnly', '(() => { window.__ac.skybox.ambient.visible = false; window.__ac.viewerLight.intensity = 0; })()', 'dungeon-torches-only');
  await step('dungeon_torchesOff', '(() => { window.__ac.skybox.ambient.visible = true; window.__ac.viewerLight.intensity = 2.25; window.__ac.sceneManager.scene.traverse((o) => { if (o.isPointLight && o.userData.datLight) o.visible = false; }); window.__ac.datLightBudget.update = () => {}; })()', 'dungeon-torches-off');
  const programs = await page.evaluate(() => { const r = (window as any).__ac?.sceneManager?.renderer; return r ? { programs: r.info.programs?.length, calls: r.info.render.calls } : null; });
  writeFileSync(`${OUT}/${TAG}-probe-samples.json`, JSON.stringify({ tag: TAG, teleport: TELEPORT, where, lights, programs, glErrors, boxes: BOXES, results }, null, 2));
  console.log('glErrors:', glErrors.length, glErrors.slice(0, 3));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
