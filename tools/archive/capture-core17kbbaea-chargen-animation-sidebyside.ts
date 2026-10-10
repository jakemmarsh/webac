/**
 * CORE.17.k.b.b.a.e.a — live capture + side-by-side for the chargen 3D
 * views' animation: gmCG3DView::StartAnimation's CharGenAnimation
 * (0x03000001, 30 fps, cyclic) on the appearance page while zoomed out and
 * on the summary page, StopAnimation's PaperDollAnimation (0x030003c0,
 * framerate 0 — frame 0 held) while zoomed in; the Olthoi's own animation
 * for both. Ours drew the setup's placement frame, still.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → Next ×3 to the appearance
 * page; a strip of shots over ~4 s of the idle loop (the animator's frame
 * and the canvas' pixel delta recorded per shot — motion is measured, not
 * eyeballed); zoom in (the rest pose: two shots, zero delta between them);
 * zoom out (the loop again from frame 0); the gender button (a restart);
 * the Olthoi Soldier (its animation, zoomed in = its frame 0); the summary
 * page (the loop). Composition: the retail heritage-page frame (the only EoL
 * chargen 3D view on file) | before (the CORE.17.k.b.b.a.e close capture:
 * the placement pose, still) | after, whole pages then viewport crops.
 *
 *   npx tsx tools/capture-core17kbbaea-chargen-animation-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbaea');
const BEFORE_DIR = join(REPO, 'verification', 'core17kbbae');
const BEFORE_APPEARANCE = join(BEFORE_DIR, 'ours-appearance-initial.png');
const BEFORE_ZOOM_OUT = join(BEFORE_DIR, 'ours-appearance-zoom-out.png');
const BEFORE_OLTHOI = join(BEFORE_DIR, 'ours-appearance-olthoi.png');
const BEFORE_SUMMARY = join(BEFORE_DIR, 'ours-summary.png');
const REF_HERITAGE = join(REPO, 'reference', 'images', 'preworld', 'char-create-ref1.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;

interface Rect { x: number; y: number; width: number; height: number }
interface AnimState { mode: string | null; id: string; frame: number; playing: boolean; parts: number; key: string }
interface ViewState {
  step: number; heritage: number; gender: number;
  view: { heading: number; position: number[]; zoomedIn: boolean; idle: boolean; epoch: number } | null;
  anim: AnimState | null;
  /** Sum of |Δ| over the chargen canvas' RGBA bytes since the previous read (−1 on the first). */
  canvasDelta: number; canvasNonBlank: number;
  ticking: boolean;
}

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const ui = window.__ac && window.__ac.gameUI;
  const v = ui && ui.chargenAppearanceView;
  const a = ui && ui.chargenViewAnimator;
  const canvas = document.querySelector('.chargen-preview-canvas') || document.querySelector('.chargen-summary-canvas');
  let delta = -1, nonBlank = 0;
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const prev = window.__kbbaeaPrev;
    if (prev && prev.length === d.length) { delta = 0; for (let i = 0; i < d.length; i++) { const x = d[i] - prev[i]; delta += x < 0 ? -x : x; } }
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBlank++;
    window.__kbbaeaPrev = d;
  }
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    heritage: ui && ui.wizard ? ui.wizard.heritage : -1, gender: ui && ui.wizard ? ui.wizard.gender : -1,
    view: v ? { heading: v.heading, position: Array.from(v.currentPosition), zoomedIn: v.zoomedIn, idle: v.idleAnimation, epoch: v.animationEpoch } : null,
    anim: a ? { mode: a.currentMode, id: '0x' + a.currentAnimationId.toString(16), frame: a.frame, playing: a.playing, parts: a.partCount, key: ui.chargenViewAnimKey } : null,
    canvasDelta: delta, canvasNonBlank: nonBlank,
    ticking: !!(ui && ui.chargenAppearanceTick),
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbaea] still waiting — reloading');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      lastReload = Date.now();
    }
    await page.waitForTimeout(2500);
  }
  return false;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), viewport: VIEW, scale: SCALE, screens: {} };
  const screens = state.screens as Record<string, { file: string; state: ViewState; note?: string }>;
  /** The state (frame + canvas delta) is read with the loop running; the
   *  screenshot itself is taken with the UI tick held — under SwiftShader a
   *  30 fps loop of offscreen renders + readPixels never leaves the
   *  compositor a frame for the capture (the first pass timed out at 150 s)
   *  — and the tick is restarted right after (its clock re-stamps, so the
   *  loop resumes where it was). A real GPU needs none of this. */
  const HOLD_JS = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui) return false; if (ui.chargenAppearanceTick) { cancelAnimationFrame(ui.chargenAppearanceTick); ui.chargenAppearanceTick = 0; return true; } return false; })()`;
  const RESUME_JS = `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.startChargenViewTicks) ui.startChargenViewTicks(); })()`;
  const shoot = async (name: string, note?: string): Promise<ViewState> => {
    const file = `ours-${name}.png`;
    const st = await page.evaluate(STATE_JS) as ViewState;
    const held = await page.evaluate(HOLD_JS).catch(() => false);
    await page.screenshot({ path: join(OUT, file), timeout: 150_000 });
    if (held) await page.evaluate(RESUME_JS).catch(() => {});
    screens[name] = { file, state: st, note };
    const a = st.anim;
    console.log(`[core17kbbaea] ${file}: step ${st.step} h${st.heritage} ${a ? `${a.mode} ${a.id} frame ${a.frame.toFixed(2)} playing ${a.playing} parts ${a.parts} key ${a.key}` : 'no animator'} delta ${st.canvasDelta} nonBlank ${st.canvasNonBlank} ticking ${st.ticking}${st.view ? ` zoomedIn ${st.view.zoomedIn} epoch ${st.view.epoch}` : ''}`);
    return st;
  };
  /** State only (no screenshot) — a cheap read of the frame + the canvas delta. */
  const probe = async (): Promise<ViewState> => page.evaluate(STATE_JS) as Promise<ViewState>;
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const clickById = (id: string): Promise<boolean> => clickSel(`#${id}`);
  const currentStep = async (): Promise<number> => page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as Promise<number>;
  const viewBtn = (key: string): string => `.chargen-view-btn[data-view-btn="${key}"]`;
  const settle = async (): Promise<void> => { await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {}); };
  const press = async (sel: string): Promise<boolean> => {
    const c = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`) as [number, number] | null;
    if (!c) { console.log(`[core17kbbaea] no element for ${sel}`); return false; }
    await page.mouse.move(c[0], c[1], { steps: 3 });
    await settle();
    await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
    await page.mouse.move(OFF_X + 400 * SCALE, OFF_Y + 590 * SCALE, { steps: 3 });
    await settle();
    return true;
  };
  const next = async (): Promise<void> => {
    const before = await currentStep();
    let clicked = false;
    for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
      clicked = await clickById('btn-next').catch(() => false);
      if (!clicked) await page.waitForTimeout(1000);
    }
    if (!clicked) await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.wizard) { ui.wizard.nextStep(); ui.renderCharacterCreate(); } })()`).catch(() => {});
    await page.waitForFunction((prev) =>
      parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, before, { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1500);
  };
  const gotoStep = async (step: number): Promise<void> => {
    await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.wizard) { ui.wizard.currentStep = ${step}; ui.renderCharacterCreate(); } })()`);
    await page.waitForTimeout(1500);
  };
  /** A strip of `n` probes + shots over the running loop. */
  const strip = async (name: string, n: number, gapMs: number, note: string): Promise<ViewState[]> => {
    const out: ViewState[] = [];
    for (let i = 0; i < n; i++) {
      out.push(await shoot(`${name}-${i}`, `${note} — shot ${i + 1}/${n}`));
      await page.waitForTimeout(gapMs);
    }
    return out;
  };

  console.log('[core17kbbaea] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbaea`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickById('btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3; i++) await next(); // heritage → profession → skills → appearance
  if (await currentStep() !== 3) await gotoStep(3);
  await page.waitForTimeout(2500);
  await probe();
  const idle = await strip('appearance-idle', 5, 600, 'InitializePage → Update → StartAnimation: CharGenAnimation 0x03000001 at 30 fps, cyclic');
  (state as Record<string, unknown>).idleDeltas = idle.map((s) => ({ frame: s.anim?.frame, delta: s.canvasDelta }));

  // Zoom in: StopAnimation — PaperDollAnimation frame 0 held: two probes, no change between them.
  await press(viewBtn('zoomIn'));
  await page.waitForTimeout(1500);
  await probe();
  await page.waitForTimeout(800);
  const restA = await shoot('appearance-rest-a', 'ZoomIn → StopAnimation: PaperDollAnimation 0x030003c0 at framerate 0 (frame 0 held)');
  await page.waitForTimeout(1200);
  const restB = await shoot('appearance-rest-b', 'the rest pose 1.2 s later: the same frame, the same pixels');
  (state as Record<string, unknown>).restDeltas = [restA.canvasDelta, restB.canvasDelta];

  // Zoom out: StartAnimation from frame 0 — the loop again.
  await press(viewBtn('zoomOut'));
  await page.waitForTimeout(1500);
  await probe();
  await strip('appearance-zoomed-out', 3, 600, 'ZoomOut → StartAnimation: the loop again from frame 0 at the full-body camera');

  // The gender button: Update → StartAnimation (a restart from frame 0 while zoomed out).
  await clickSel('.gender-btn[data-gender="2"]');
  await page.waitForTimeout(400);
  await shoot('appearance-gender-female', 'the gender button: SetGender + Update → StartAnimation restarts the loop (epoch +1)');

  // Olthoi Soldier: CharGenOlthoiAnimation for both slots.
  await gotoStep(0);
  await clickSel('.heritage-btn[data-heritage="12"]');
  await page.waitForTimeout(800);
  await gotoStep(3);
  await page.waitForTimeout(2500);
  await probe();
  await strip('appearance-olthoi', 3, 600, 'Olthoi Soldier: CharGenOlthoiAnimation 0x03000045 (25 parts, 40 frames) looping');
  await press(viewBtn('zoomIn'));
  await page.waitForTimeout(1500);
  await probe();
  await page.waitForTimeout(800);
  await shoot('appearance-olthoi-rest', 'Olthoi zoomed in: StopAnimation = the SAME 0x03000045 at framerate 0 (its frame 0)');

  // The summary page: InitializePage → StartAnimation.
  await gotoStep(0);
  await clickSel('.heritage-btn[data-heritage="1"]');
  await page.waitForTimeout(800);
  await gotoStep(5);
  await page.waitForTimeout(2500);
  await probe();
  await strip('summary', 4, 600, 'gmCGSummaryPage::InitializePage → StartAnimation: the loop in 0x10000406');

  await clickById('btn-cancel');
  await page.waitForTimeout(500);
  const gone = await probe();
  (state as Record<string, unknown>).afterCancel = { anim: gone.anim, ticking: gone.ticking };
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
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
function frameRect(dat: Rect): Rect {
  return { x: OFF_X + dat.x * SCALE, y: OFF_Y + dat.y * SCALE, width: dat.width * SCALE, height: dat.height * SCALE };
}
function cropOurs(file: string, dat: Rect, label: string, zoom: number): string {
  return cropOf(file, frameRect(dat), VIEW.width, VIEW.height, label, zoom / SCALE);
}
/** The retail ref is 600x450 = the 800x600 frame at 0.75. */
function cropRef(dat: Rect, label: string, zoom: number): string {
  const r = { x: dat.x * 0.75, y: dat.y * 0.75, width: dat.width * 0.75, height: dat.height * 0.75 };
  return cropOf(REF_HERITAGE, r, 600, 450, label, zoom / 0.75);
}
function frame(file: string, label: string, width = 700): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
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
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2300, height: 900 } });
  const ours = (n: string) => join(OUT, `ours-${n}.png`);
  const live = existsSync(join(OUT, 'live-state.json')) ? JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) : null;
  const noteOf = (n: string): string => {
    const s = live?.screens?.[n];
    if (!s) return '';
    const a = s.state?.anim;
    return a ? ` — ${a.mode} ${a.id} frame ${a.frame.toFixed(1)}, Δpx ${s.state.canvasDelta}` : '';
  };
  const VIEW_ALL: Rect = { x: 520, y: 70, width: 275, height: 500 };
  const VIEW_FRAME: Rect = { x: 524, y: 72, width: 265, height: 395 };
  const REF_VIEW: Rect = { x: 250, y: 70, width: 265, height: 450 };
  const SUMMARY_VIEW: Rect = { x: 575, y: 82, width: 220, height: 460 };
  const names = Object.keys(live?.screens ?? {});
  const html = `${CSS}<h1>CORE.17.k.b.b.a.e.a — chargen 3D views: gmCG3DView::StartAnimation (CharGenAnimation 0x03000001, 30 fps, cyclic) while zoomed out / on the summary page, StopAnimation (PaperDollAnimation 0x030003c0 at 0 fps — frame 0 held) while zoomed in. Before: the setup's placement pose, still. Every after-shot records the animator's frame and the canvas' pixel delta since the previous read (motion measured, not eyeballed).</h1>
    <div class="row">${frame(REF_HERITAGE, 'reference char-create-ref1.png (600x450, retail heritage page — its 3D view: a front-lit character facing the camera; the appearance page has no EoL screenshot on file)', 600)}</div>
    <h2>the appearance view: retail | before (CORE.17.k.b.b.a.e close: the placement pose, still) | after — the idle loop, five shots ~0.6 s apart (1.2x)</h2>
    <div class="row">${cropRef(REF_VIEW, 'retail — heritage page 3D view', 1.2)}${cropOurs(BEFORE_APPEARANCE, VIEW_FRAME, 'before — placement frame, no animation', 1.2)}${[0, 1, 2, 3, 4].map((i) => cropOurs(ours(`appearance-idle-${i}`), VIEW_FRAME, `after — idle ${i}${noteOf(`appearance-idle-${i}`)}`, 1.2)).join('')}</div>
    <h2>zoomed in: StopAnimation — the rest pose (PaperDollAnimation frame 0) held: two shots 1.2 s apart (Δpx between them = ${live?.restDeltas?.[1] ?? '?'}) (1.2x)</h2>
    <div class="row">${cropOurs(BEFORE_APPEARANCE, VIEW_FRAME, 'before — the placement pose (the old "zoomed in" too)', 1.2)}${['appearance-rest-a', 'appearance-rest-b'].map((n) => cropOurs(ours(n), VIEW_FRAME, `${n}${noteOf(n)}`, 1.2)).join('')}</div>
    <h2>zoomed out again: StartAnimation from frame 0 (full-body camera) | the gender button: Update → a restart — before (kbbae zoom-out) | after (1.2x)</h2>
    <div class="row">${cropOurs(BEFORE_ZOOM_OUT, VIEW_FRAME, 'before — zoomed out, placement pose', 1.2)}${['appearance-zoomed-out-0', 'appearance-zoomed-out-1', 'appearance-zoomed-out-2', 'appearance-gender-female'].map((n) => cropOurs(ours(n), VIEW_FRAME, `${n}${noteOf(n)}`, 1.2)).join('')}</div>
    <h2>Olthoi Soldier: CharGenOlthoiAnimation 0x03000045 looping | zoomed in: the same animation at 0 fps (its frame 0) — before (kbbae) | after (1.2x)</h2>
    <div class="row">${cropOurs(BEFORE_OLTHOI, VIEW_FRAME, 'before — Olthoi placement pose', 1.2)}${['appearance-olthoi-0', 'appearance-olthoi-1', 'appearance-olthoi-2', 'appearance-olthoi-rest'].map((n) => cropOurs(ours(n), VIEW_FRAME, `${n}${noteOf(n)}`, 1.2)).join('')}</div>
    <h2>the summary view 0x10000406: InitializePage → StartAnimation — before (CORE.17.k.b.b.a.e close: still) | after, four shots (1.2x)</h2>
    <div class="row">${cropOurs(BEFORE_SUMMARY, SUMMARY_VIEW, 'before — summary view, placement pose', 1.2)}${[0, 1, 2, 3].map((i) => cropOurs(ours(`summary-${i}`), SUMMARY_VIEW, `after — summary ${i}${noteOf(`summary-${i}`)}`, 1.2)).join('')}</div>
    <h2>whole pages (before | after)</h2>
    <div class="row">${frame(BEFORE_APPEARANCE, 'before — appearance (CORE.17.k.b.b.a.e close capture)')}${frame(ours('appearance-idle-0'), `after — appearance${noteOf('appearance-idle-0')}`)}</div>
    <div class="row">${frame(BEFORE_SUMMARY, 'before — summary (CORE.17.k.b.b.a.e close capture)')}${frame(ours('summary-0'), `after — summary${noteOf('summary-0')}`)}</div>
    ${names.filter((n) => existsSync(ours(n))).map((n) => `<div class="row">${frame(ours(n), `${n}${noteOf(n)}`, 900)}</div>`).join('')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbaea-animation-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbaea] wrote ${join(OUT, 'core17kbbaea-animation-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
