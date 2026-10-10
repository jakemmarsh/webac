/**
 * CORE.17.h.g.c — live probe for the Landscape / Environment Texture Detail
 * round trip: lower the level, then restore the default, and check that the
 * world really comes back at full resolution.
 *
 * Per step it records, for every registered texture of the kind under test,
 * the CPU image size, texture/source versions, the WebGLTextures bookkeeping
 * (`renderer.properties`: __version / __cacheKey / GL object present) and
 * how many registered textures share the same Source; plus `gl.getError()`
 * after a frame and a sharpness number for a ground / building crop (mean
 * |Δ| between horizontally adjacent pixels — a downscaled texture reads
 * blurrier, i.e. lower). Screenshots per step go under verification/core17hgc/.
 *
 * Usage: npx tsx tools/probe-core17hgc-detail-restore.ts [--kind landscape|environment]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgc');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const kindIdx = process.argv.indexOf('--kind');
const KIND = kindIdx >= 0 ? process.argv[kindIdx + 1] : 'landscape';
const PREF = KIND === 'landscape' ? 'landscapeTextureDetail' : 'environmentTextureDetail';
const DEFAULT_LEVEL = KIND === 'landscape' ? 2 : 1;
const CROP = KIND === 'landscape' ? { x: 560, y: 560, w: 320, h: 150 } : { x: 520, y: 200, w: 420, h: 220 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function login(page: Page): Promise<void> {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  // Close any panel the persisted UI state left open (the options panel
  // survives reloads and would cover the buildings crop).
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); })()`);
  await page.waitForTimeout(2500);
}

const DUMP_JS = (kind: string) => `(() => {
  const ac = window.__ac;
  const p = ac.textureSamplerPrefs;
  const renderer = ac.sceneManager.renderer;
  const gl = renderer.getContext();
  const err = gl.getError();
  const reg = p.registry;
  const bySource = new Map();
  for (const [tex, r] of reg) { if (r.kind !== ${JSON.stringify(kind)}) continue; bySource.set(tex.source, (bySource.get(tex.source) || 0) + 1); }
  const rows = [];
  const sizeHist = {};
  for (const [tex, r] of reg) {
    if (r.kind !== ${JSON.stringify(kind)}) continue;
    const tp = renderer.properties.get(tex);
    const sp = renderer.properties.get(tex.source);
    const key = tex.image.width + 'x' + tex.image.height;
    sizeHist[key] = (sizeHist[key] || 0) + 1;
    rows.push({
      uuid: tex.uuid.slice(0, 8), image: key, full: r.fullRes.width + 'x' + r.fullRes.height, shift: r.shift,
      version: tex.version, sourceVersion: tex.source.version,
      glVersion: tp.__version, glSourceVersion: sp.__version, glInit: !!tp.__webglInit, hasGl: !!tp.__webglTexture,
      cacheKey: tp.__cacheKey, sharedSource: bySource.get(tex.source),
    });
  }
  return { glError: err, count: rows.length, sizeHist, rows: rows.slice(0, 12), sample: rows.filter((r) => r.sharedSource > 1).slice(0, 6) };
})()`;

async function sharpness(page: Page, crop: { x: number; y: number; w: number; h: number }): Promise<number> {
  const buf = await page.screenshot({ clip: { x: crop.x, y: crop.y, width: crop.w, height: crop.h } });
  return page.evaluate(`(async () => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${buf.toString('base64')}'; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 1; x < c.width; x++) {
      const i = (y * c.width + x) * 4, j = i - 4;
      sum += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
      n++;
    }
    return sum / (3 * n);
  })()`) as Promise<number>;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  await login(page);

  const steps = [
    { name: 'default', level: DEFAULT_LEVEL },
    { name: 'verylow', level: 4 },
    { name: 'restored', level: DEFAULT_LEVEL },
    { name: 'low', level: 3 },
    { name: 'restored2', level: DEFAULT_LEVEL },
  ];
  const results: unknown[] = [];
  for (const s of steps) {
    await page.evaluate(`window.__ac.gameUI.applyOptionsBulk({ ${PREF}: ${s.level} })`);
    await page.waitForTimeout(3000);
    const dump = await page.evaluate(DUMP_JS(KIND));
    const sharp = await sharpness(page, CROP);
    await page.screenshot({ path: join(OUT, `restore-${KIND}-${s.name}.png`) });
    const row = { step: s.name, level: s.level, sharpness: sharp, ...(dump as object) };
    results.push(row);
    const d = dump as { glError: number; sizeHist: Record<string, number>; sample: unknown[] };
    console.log(`[restore-probe] ${KIND} ${s.name} (level ${s.level}): sharpness ${sharp.toFixed(2)} sizes ${JSON.stringify(d.sizeHist)} glError ${d.glError}`);
    if (d.sample.length) console.log(`  shared-source sample: ${JSON.stringify(d.sample.slice(0, 2))}`);
  }
  writeFileSync(join(OUT, `restore-${KIND}-probe.json`), JSON.stringify(results, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
