/**
 * CORE.17.q.a.a — live evidence that the Config "Screen Brightness" slider is
 * retail's swap-chain gamma ramp on the WHOLE frame (RenderDeviceD3D::SetGamma
 * @ 005a0b70: ramp[i] = i·255·(1 + 2·clamp(pref, −0.2, 1)) → SetGammaRamp on
 * the back buffer, HUD included — docs/retail-client-symbols.md CORE.17.q.a.a).
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright,
 * logs in, opens the Options panel's Config tab, and for each slider value
 * applies it through the panel's own apply path (applyOptionsBulk — what the
 * slider drag calls), re-renders the panel (the thumb moves) and shoots the
 * whole screen:
 *   after-pref-0 / +0.25 / +1 / -0.2 / -1   → body filter '' / 1.5 / 3 / 0.6 / 0.6
 * The BEFORE frames re-create the retired VISUAL3.70 rule on the same live
 * page (canvas-only brightness(1 + 0.5·pref), body untouched) for +1 / −1.
 * Then samples the mean luminance of a HUD region (the vitals / toolbar
 * strip), the Options panel and the world centre from every PNG, writes
 * live-state.json and composes core17qaa-screen-gamma-sidebyside.png
 * (retail options-config.jpg | before | after per beat, whole screens).
 *
 * Usage: npx tsx tools/capture-core17qaa-screen-gamma.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17qaa');
const RETAIL_CONFIG = join(REPO, 'reference/images/hud/options-config.jpg');
const STATE = join(OUT, 'live-state.json');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

const PREFS = [0, 0.25, 1, -0.2, -1] as const;
const BEFORE_PREFS = [1, -1] as const;
const tag = (p: number): string => (p < 0 ? `m${String(-p).replace('.', '_')}` : String(p).replace('.', '_'));

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

interface Beat {
  kind: 'before' | 'after';
  pref: number;
  file: string;
  bodyFilter: string;
  canvasFilter: string;
  sliderLeft: number | null;
  panelVisible: boolean;
}

async function readState(page: Page): Promise<Omit<Beat, 'kind' | 'pref' | 'file'>> {
  return page.evaluate(() => {
    const w = window as any;
    const ui = w.__ac?.gameUI;
    const row = ui?.optionsPanel?.querySelector('[data-option-row="slider"][data-option-key="screenBrightness"]') as HTMLElement | null;
    const thumb = row?.querySelector('.options-slider-track .options-slider-thumb') as HTMLElement | null;
    const left = thumb ? parseFloat(thumb.style.left) : null;
    return {
      bodyFilter: document.body.style.filter,
      canvasFilter: (document.getElementById('game-canvas') as HTMLElement | null)?.style.filter ?? '',
      sliderLeft: Number.isFinite(left as number) ? (left as number) : null,
      panelVisible: !!ui?.optionsPanelVisible,
    };
  });
}

async function captureLive(): Promise<Beat[]> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (msg) => {
    const t = msg.text();
    if (/error|Error/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });
  console.log(`[core17qaa] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17qaa] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core17qaa] in world; letting the login notices expire');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.waitForTimeout(1500);

  // Open the Options panel on its Config tab (the tab the slider lives on).
  await page.evaluate(() => {
    const ui = (window as any).__ac?.gameUI;
    if (!ui) throw new Error('no __ac.gameUI');
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config';
    ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
  });
  await page.waitForTimeout(1200);

  const beats: Beat[] = [];
  const setPref = async (pref: number): Promise<void> => {
    await page.evaluate((p) => {
      const ui = (window as any).__ac.gameUI;
      ui.applyOptionsBulk({ screenBrightness: p });
      ui.saveOptionsSettings();
      if (ui.optionsPanelVisible) ui.renderOptionsPanel();
    }, pref);
    await page.waitForTimeout(700);
  };

  for (const pref of PREFS) {
    await setPref(pref);
    const file = join(OUT, `after-pref-${tag(pref)}.png`);
    await page.screenshot({ path: file });
    const st = await readState(page);
    beats.push({ kind: 'after', pref, file, ...st });
    console.log(`[core17qaa] after pref ${pref}: body="${st.bodyFilter}" canvas="${st.canvasFilter}" thumb=${st.sliderLeft} → ${file}`);
  }

  // BEFORE: the retired VISUAL3.70 rule — canvas-only brightness(1 + 0.5·pref).
  for (const pref of BEFORE_PREFS) {
    await setPref(pref);
    await page.evaluate((p) => {
      document.body.style.filter = '';
      (document.getElementById('game-canvas') as HTMLElement).style.filter = `brightness(${(1 + 0.5 * p).toFixed(3)})`;
    }, pref);
    await page.waitForTimeout(700);
    const file = join(OUT, `before-pref-${tag(pref)}.png`);
    await page.screenshot({ path: file });
    const st = await readState(page);
    beats.push({ kind: 'before', pref, file, ...st });
    console.log(`[core17qaa] before pref ${pref}: body="${st.bodyFilter}" canvas="${st.canvasFilter}" → ${file}`);
    await page.evaluate(() => { (document.getElementById('game-canvas') as HTMLElement).style.filter = ''; });
  }

  // Restore the default and leave the profile clean.
  await setPref(0);
  const rest = await readState(page);
  console.log(`[core17qaa] restored default: body="${rest.bodyFilter}" canvas="${rest.canvasFilter}"`);
  await browser.close();
  return beats;
}

interface Region { name: string; x: number; y: number; w: number; h: number }
// 1568x775 viewport: the vitals / toolbar strip (top-left HUD), the Options
// panel body (right), the world centre (no HUD).
const REGIONS: Region[] = [
  { name: 'hud-vitals-toolbar', x: 0, y: 0, w: 420, h: 60 },
  { name: 'options-panel', x: 1180, y: 120, w: 300, h: 300 },
  { name: 'world-centre', x: 600, y: 300, w: 300, h: 200 },
];

async function sampleLuminance(page: Page, file: string): Promise<Record<string, number>> {
  return page.evaluate(async ({ src, regions }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const out: Record<string, number> = {};
    for (const r of regions) {
      const d = ctx.getImageData(r.x, r.y, r.w, r.h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      out[r.name] = Math.round((sum / (d.length / 4)) * 10) / 10;
    }
    return out;
  }, { src: dataUrl(file), regions: REGIONS });
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px;max-width:640px}
  .lbl{color:#ffd;white-space:normal}
  .cell img{display:block;width:620px;height:auto;border:1px solid #444}
  h1{font-size:14px;margin:0 0 8px} h2{font-size:13px;margin:12px 0 4px;color:#9cf}
  table{border-collapse:collapse;margin:6px 0} td,th{border:1px solid #555;padding:2px 8px;text-align:right} th{color:#9cf}
</style>`;

async function compose(beats: Beat[]): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 } });
  await page.setContent('<html><body></body></html>');
  const lum: Record<string, Record<string, number>> = {};
  for (const b of beats) lum[`${b.kind}-${b.pref}`] = await sampleLuminance(page, b.file);
  for (const b of beats) console.log(`[core17qaa] luminance ${b.kind} pref ${b.pref}: ${JSON.stringify(lum[`${b.kind}-${b.pref}`])}`);

  const find = (kind: Beat['kind'], pref: number): Beat | undefined => beats.find((b) => b.kind === kind && b.pref === pref);
  const cell = (label: string, file: string): string => `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}"/></div>`;
  const rows = beats.map((b) => {
    const l = lum[`${b.kind}-${b.pref}`];
    return `<tr><td>${b.kind}</td><td>${b.pref}</td><td>${b.bodyFilter || '(none)'}</td><td>${b.canvasFilter || '(none)'}</td>${REGIONS.map((r) => `<td>${l[r.name]}</td>`).join('')}</tr>`;
  }).join('');
  const table = `<table><tr><th>frame</th><th>pref</th><th>body filter</th><th>canvas filter</th>${REGIONS.map((r) => `<th>${r.name} mean Y</th>`).join('')}</tr>${rows}</table>`;

  const a0 = find('after', 0)!; const a1 = find('after', 1)!; const am = find('after', -1)!; const aq = find('after', 0.25)!; const am02 = find('after', -0.2)!;
  const b1 = find('before', 1)!; const bm = find('before', -1)!;
  await page.setContent(`${CSS}
    <h1>CORE.17.q.a.a — Config "Screen Brightness" = RenderDeviceD3D::SetGamma's swap-chain ramp (ramp[i] = i·255·(1 + 2·clamp(pref, −0.2, 1)), the whole back buffer incl. the HUD) — retail | before | after</h1>
    <h2>The Config page (retail options-config.jpg shows the slider; no retail frame at a non-default brightness exists in the corpus — the ramp is anchored to the decomp + .rdata)</h2>
    <div class="row">
      ${cell('retail EoL Options → Config (options-config.jpg): Screen Brightness slider, Dark … Bright', RETAIL_CONFIG)}
      ${cell(`ours, slider at the default 0: no filter installed (retail installs no ramp until the pref changes) — body "${a0.bodyFilter || '(none)'}"`, a0.file)}
    </div>
    <h2>Slider at Bright (+1): retail = 3× on every pixel of the frame, HUD included (values ≥ 86 saturate)</h2>
    <div class="row">
      ${cell(`BEFORE (VISUAL3.70 rule re-created live): canvas-only brightness(1.500), the HUD untouched — canvas "${b1.canvasFilter}", body "${b1.bodyFilter || '(none)'}"`, b1.file)}
      ${cell(`AFTER: body "${a1.bodyFilter}" — world AND HUD / Options panel through the same ramp`, a1.file)}
    </div>
    <h2>Slider at Dark (−1): retail clamps the pref to −0.2 → 0.6× (the −1..−0.2 half of the slider is flat)</h2>
    <div class="row">
      ${cell(`BEFORE: canvas-only brightness(0.500) — canvas "${bm.canvasFilter}"`, bm.file)}
      ${cell(`AFTER: body "${am.bodyFilter}" (= the −0.2 frame: "${am02.bodyFilter}")`, am.file)}
    </div>
    <h2>Slider at +0.25 → 1.5× (the factor the old rule gave at +1)</h2>
    <div class="row">${cell(`AFTER: body "${aq.bodyFilter}"`, aq.file)}${cell(`AFTER −0.2: body "${am02.bodyFilter}"`, am02.file)}</div>
    <h2>Mean luminance (Rec.709 Y of the PNG) per region — the HUD regions are translucent panels over the world, so the BEFORE frames move them a little through the canvas; the AFTER frames move them by the full ramp (options panel 79 → 207 at +1 vs 94 before)</h2>
    ${table}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17qaa-screen-gamma-sidebyside.png'), fullPage: true });
  writeFileSync(STATE, JSON.stringify({ url: URL, view: VIEW, regions: REGIONS, beats, luminance: lum }, null, 2));
  await browser.close();
  console.log(`[core17qaa] wrote ${join(OUT, 'core17qaa-screen-gamma-sidebyside.png')} + ${STATE}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  let beats: Beat[];
  if (process.argv.includes('--compose-only')) {
    beats = (JSON.parse(readFileSync(STATE, 'utf8')) as { beats: Beat[] }).beats;
  } else {
    beats = await captureLive();
    writeFileSync(STATE, JSON.stringify({ url: URL, view: VIEW, beats }, null, 2));
  }
  await compose(beats);
}

main().catch((err) => { console.error(err); process.exit(1); });
