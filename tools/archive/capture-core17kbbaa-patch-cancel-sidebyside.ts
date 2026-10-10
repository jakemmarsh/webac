/**
 * CORE.17.k.b.b.a.a — live evidence for the loading screen (LayoutDesc
 * 0x21000000, gmDataPatchUI) drawing its Cancel button 0x1000041c:
 *
 *   plate media 0x06004ca9 (normal) / 0x06004caa (hover) / 0x06004ca8
 *   (pressed) / 0x06004ca7 (disabled), the "Cancel" label (string
 *   134262076) in font 0x40000016, white, p33 black outline, centred; a
 *   click queues the epilogue mode (gmDataPatchUI::ListenToElementMessage @
 *   004ede30 → UIFramework::QueueUIMode(0x10000009)), whose blank 800x600
 *   frame exits the client on its first UI tick (the root's Message media
 *   0x10000002 → gmEpilogueUI::ListenToElementMessage @ 004e9c40 →
 *   Device::Done) — ours relaunches on the next animation frame.
 *
 * The live pass drives the running stack: the cell DAT request is held by a
 * Playwright route so the splash stays up, then (after mode) hovers, presses
 * and clicks Cancel, then waits for the relaunch (the epilogue frame lasts
 * one animation frame, like retail's one tick — it is not capturable). `before-splash.png` is the previous build's splash (run with
 * --before on that build). The compose step writes
 *   core17kbbaa-patch-cancel-sidebyside.png   DAT ground truth | before | after
 *                                             (whole frames + 3x crops)
 *   core17kbbaa-live-state.json               per-element live state
 * under verification/core17kbbaa/.
 *
 * Usage: npx tsx tools/capture-core17kbbaa-patch-cancel-sidebyside.ts [--before | --compose-only]
 */
import { chromium, type Page, type Route } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
/** The pre-world 800x600 frame letterboxed into the viewport (attachPreworldScale). */
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;
/** The previous build centred the 800x600 splash 1:1 (no scale). */
const OFF1_X = (VIEW.width - 800) / 2;
const OFF1_Y = (VIEW.height - 600) / 2;

/** Layout 0x21000000 rects (800x600). */
const CANCEL_RECT = { x: 696, y: 30, width: 100, height: 45 };
const COPYRIGHT_RECT = { x: 0, y: 467, width: 800, height: 40 };
const LABELS_RECT = { x: 0, y: 505, width: 800, height: 95 };
const PLATES = { normal: 0x06004ca9, hover: 0x06004caa, pressed: 0x06004ca8, disabled: 0x06004ca7 };
const TITLE_IMAGE = 0x06001343;

interface Rect { x: number; y: number; width: number; height: number }

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const el = (id) => document.getElementById(id);
  const rectOf = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const ds = (e) => e ? { ...e.dataset } : null;
  const overlay = el('loading-overlay');
  const inner = overlay ? overlay.firstElementChild : null;
  const cancel = el('patch-cancel');
  const label = cancel ? cancel.querySelector('canvas,span') : null;
  const copyright = el('patch-copyright');
  return {
    overlayPresent: !!overlay,
    innerTransform: inner ? inner.style.transform : null,
    innerRect: rectOf(inner),
    titleImage: !!(overlay && overlay.querySelector('img')),
    cancel: cancel ? { rect: rectOf(cancel), dataset: ds(cancel), label: label ? { tag: label.tagName, width: label.width, height: label.height, dataset: ds(label) } : null } : null,
    copyright: copyright ? { rect: rectOf(copyright), dataset: ds(copyright), canvases: copyright.querySelectorAll('canvas').length } : null,
    left: el('load-text-left') ? { dataset: ds(el('load-text-left')), child: el('load-text-left').firstElementChild ? el('load-text-left').firstElementChild.tagName : null, childDataset: ds(el('load-text-left').firstElementChild) } : null,
    right: el('load-text-right') ? { dataset: ds(el('load-text-right')), childDataset: ds(el('load-text-right').firstElementChild) } : null,
    epilogue: el('epilogue-inner') ? { rect: rectOf(el('epilogue-inner')), dataset: ds(el('epilogue-inner')) } : null,
  };
})()`;

async function captureLive(before: boolean): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const context = await browser.newContext({ viewport: VIEW });
  const page = await context.newPage();
  page.on('dialog', (d) => void d.dismiss());
  const failed: string[] = [];
  page.on('requestfailed', (r) => { if (/client_cell_1\.dat/.test(r.url())) failed.push(`${r.method()} ${r.failure()?.errorText ?? '?'}`); });
  const pageLog: string[] = [];
  page.on('console', (m) => {
    if (!/\[AC\] (patch|epilogue|Fatal)/i.test(m.text())) return;
    pageLog.push(m.text().slice(0, 200));
    console.log(`  [page] ${m.text().slice(0, 140)}`);
  });
  // Hold every request for the cell DAT (HEAD + GET) so the splash stays up
  // mid-patch (the patch label on its progress line, CORE.17.k.b.b.a.a.a)
  // until we are done.
  const held: Route[] = [];
  await page.route('**/client_cell_1.dat*', (route) => { held.push(route); });

  const prefix = before ? 'before' : 'ours';
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), viewport: VIEW, scale: SCALE, mode: prefix, screens: {} };
  const screens = state.screens as Record<string, { file: string; live: unknown }>;
  const shoot = async (name: string): Promise<void> => {
    const file = `${prefix}-${name}.png`;
    await page.screenshot({ path: join(OUT, file) });
    screens[name] = { file, live: await page.evaluate(STATE_JS) };
    console.log(`[core17kbbaa] ${file}`);
  };

  console.log(`[core17kbbaa] navigating (${prefix})`);
  await page.goto(`${BASE}&autoenter=false&cb=kbbaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  // The DAT splash replaces the black placeholder once portal.dat is parsed.
  await page.waitForFunction(() => !!document.querySelector('#loading-overlay img'), undefined, { timeout: 240_000 });
  // Let the connect probe settle and the patch label reach its progress line.
  await page.waitForTimeout(2500);
  await shoot('splash');

  if (!before) {
    const cancel = page.locator('#patch-cancel');
    if (await cancel.count() === 0) throw new Error('#patch-cancel not found on the splash');
    await cancel.hover();
    await page.waitForTimeout(300);
    await shoot('splash-hover');
    await page.mouse.down();
    await page.waitForTimeout(300);
    await shoot('splash-pressed');
    // UIElement_Button::MouseUp broadcasts element message 1 → the epilogue,
    // whose Message media is Device::Done on the next tick — ours relaunches.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      page.mouse.up(),
    ]);
    state.cellRequestFailures = failed.slice();
    await page.waitForFunction(() => !!document.querySelector('#loading-overlay img'), undefined, { timeout: 240_000 });
    await page.waitForTimeout(2500);
    await shoot('relaunched');
  }
  state.cellRequestsHeld = held.length;
  // The abort shows up as main()'s AbortError catch ("patch cancelled —
  // epilogue"), not as a Playwright requestfailed: the held route never
  // reached the network.
  state.pageLog = pageLog;
  writeFileSync(join(OUT, `${prefix}-live-state.json`), JSON.stringify(state, null, 2));
  for (const r of held) r.abort().catch(() => {});
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : file.endsWith('.webp') ? 'webp' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function cropOf(file: string, rect: Rect, frameW: number, frameH: number, label: string, zoom: number): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><div class="crop" style="width:${Math.round(rect.width * zoom)}px;height:${Math.round(rect.height * zoom)}px"><img src="${dataUrl(file)}" style="left:${-rect.x * zoom}px;top:${-rect.y * zoom}px;width:${frameW * zoom}px;height:${frameH * zoom}px"/></div></div>`;
}
/** A DAT 800x600 rect → the letterboxed (after) frame. */
function frameRect(dat: Rect): Rect {
  return { x: OFF_X + dat.x * SCALE, y: OFF_Y + dat.y * SCALE, width: dat.width * SCALE, height: dat.height * SCALE };
}
/** A DAT 800x600 rect → the previous build's unscaled centred frame. */
function frameRect1(dat: Rect): Rect {
  return { x: OFF1_X + dat.x, y: OFF1_Y + dat.y, width: dat.width, height: dat.height };
}
function cropAfter(file: string, dat: Rect, label: string, zoom: number): string {
  return cropOf(file, frameRect(dat), VIEW.width, VIEW.height, label, zoom / SCALE);
}
function cropBefore(file: string, dat: Rect, label: string, zoom: number): string {
  return cropOf(file, frameRect1(dat), VIEW.width, VIEW.height, label, zoom);
}
function frame(file: string, label: string, width = 700): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
}
function datImage(did: number, label: string, zoom: number): string {
  const file = join(OUT, `0x${did.toString(16).padStart(8, '0')}.png`);
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no dump)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="zoom:${zoom};image-rendering:pixelated;border:1px solid #444"/></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:700px}
  .crop{position:relative;overflow:hidden;border:1px solid #444}
  .crop img{position:absolute;image-rendering:pixelated}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:14px 0 0;color:#9cf}
</style>`;

async function compose(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // DAT ground truth: the plate faces + the title image, straight from portal.dat.
  const dids = [...Object.values(PLATES), TITLE_IMAGE];
  if (!dids.every((d) => existsSync(join(OUT, `0x${d.toString(16).padStart(8, '0')}.png`)))) {
    try {
      execFileSync('npx', ['tsx', join(REPO, 'tools', 'dump-ui-texture-pngs.ts'), ...dids.map((d) => `0x${d.toString(16).padStart(8, '0')}`), OUT], { stdio: 'inherit' });
    } catch (e) { console.warn('[core17kbbaa] texture dump failed:', (e as Error).message); }
  }
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2200, height: 900 } });
  const before = (n: string) => join(OUT, `before-${n}.png`);
  const ours = (n: string) => join(OUT, `ours-${n}.png`);
  const html = `${CSS}<h1>CORE.17.k.b.b.a.a — loading screen 0x21000000 (gmDataPatchUI): the Cancel button 0x1000041c (696,30) 100x45 — template 0x21000040:0x100002d3, plates 0x06004ca9/aa/a8/a7, "Cancel" (134262076) in font 0x40000016 white with the p33 black outline; the copyright 0x1000041d in font 0x40000002 (string 171998484, two lines, centred / top) and the meter labels 0x10000420 / 0x10000421 in font 0x40000001. No retail frame of the patch screen is on file (the loading-ref*.webp references are the login screen) — the DAT is the ground truth.</h1>
    <div class="row">${frame(before('splash'), 'before — previous build (no Cancel button, UI-font labels, invented copyright, unscaled 800x600)')}${frame(ours('splash'), 'after — Cancel drawn at the DAT rect, DAT fonts, DAT copyright, the frame letterboxed like every pre-world screen (CORE.13.a)')}</div>
    <h2>the Cancel button — DAT plate | ours, 3x</h2>
    <div class="row">${datImage(PLATES.normal, 'DAT 0x06004ca9 (state 0x1 normal)', 3)}${cropBefore(before('splash'), CANCEL_RECT, 'before (nothing drawn at the rect)', 3)}${cropAfter(ours('splash'), CANCEL_RECT, 'after — normal', 3)}</div>
    <div class="row">${datImage(PLATES.hover, 'DAT 0x06004caa (state 0x2 hover)', 3)}${cropAfter(ours('splash-hover'), CANCEL_RECT, 'after — hover (mouse over)', 3)}</div>
    <div class="row">${datImage(PLATES.pressed, 'DAT 0x06004ca8 (state 0x3 pressed)', 3)}${cropAfter(ours('splash-pressed'), CANCEL_RECT, 'after — pressed (mouse down)', 3)}</div>
    <h2>copyright 0x1000041d (0,467) 800x40 — font 0x40000002, string 171998484 — 2x</h2>
    <div class="row">${cropBefore(before('splash'), COPYRIGHT_RECT, 'before (invented one-liner, UI font 0x40000000)', 2)}</div>
    <div class="row">${cropAfter(ours('splash'), COPYRIGHT_RECT, 'after (the DAT string, two lines, font 0x40000002)', 2)}</div>
    <h2>meters + labels 0x1000041e/f + 0x10000420/1 — font 0x40000001 — 1.5x</h2>
    <div class="row">${cropBefore(before('splash'), LABELS_RECT, 'before (UI font 0x40000000)', 1.5)}</div>
    <div class="row">${cropAfter(ours('splash'), LABELS_RECT, 'after (font 0x40000001)', 1.5)}</div>
    <h2>the click: epilogue (gmEpilogueUI, layout 0x21000036 — a blank 800x600 frame whose Message media is Device::Done on the first tick) → relaunch</h2>
    <div class="row">${frame(ours('relaunched'), 'after — relaunched: the splash again (the cell DAT load was aborted: ours-live-state.json pageLog)', 520)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17kbbaa-patch-cancel-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbaa] wrote ${join(OUT, 'core17kbbaa-patch-cancel-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--before')) { await captureLive(true); return; }
  if (!process.argv.includes('--compose-only')) await captureLive(false);
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
