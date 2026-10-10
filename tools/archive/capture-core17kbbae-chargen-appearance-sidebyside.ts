/**
 * CORE.17.k.b.b.a.e — live capture + side-by-side for the chargen appearance
 * page's 3D view 0x100003bb: gmCGAppearancePage's face camera at heading 180
 * (the model facing the camera — ours drew its back at a full-body camera),
 * the 0x2100004c:0x10000322 rotate / zoom buttons in the page's 0x100003bc
 * (p11 toggles: media per state 1 / 2 / 6 / 7), the 3 s/turn rotation, the
 * 0.6 s zoom lerp to gmCGSummaryPage's full-body camera and back, and the
 * gmCG3DView light (DISTANT_LIGHT 2.0 along (0.3, 1.9, 0.65) over the 0.3
 * CreatureMode ambient) — which the summary view shares.
 *
 * Live pass (Playwright / SwiftShader against the in-container ACE stack):
 * connect → char select → Create Character → Next ×3 to the appearance
 * page; the initial view; the rotate-clockwise button hovered, clicked
 * (shots while it turns), clicked again (stopped); counter-clockwise; zoom
 * in (lit); zoom out (the lerp, then the full body); zoom in again; the
 * gender button (the camera back on the face). Then Aun Tumerok and Olthoi
 * Soldier variants of the page (their own face cameras) and the summary
 * page (the shared light). Composition: the retail heritage-page frame
 * (reference/images/preworld/char-create-ref1.png — the only EoL chargen 3D
 * view on file: a front-lit character facing the camera) | before (the
 * CORE.17.k.b.b.a.b close capture, the model's back) | after, whole pages
 * then viewport / button crops.
 *
 *   npx tsx tools/capture-core17kbbae-chargen-appearance-sidebyside.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbae');
const BEFORE_APPEARANCE = join(REPO, 'verification', 'core17kbbab', 'ours-char-create-appearance.png');
const BEFORE_SUMMARY = join(REPO, 'verification', 'core17kbbac', 'ours-char-create-summary.png');
const REF_HERITAGE = join(REPO, 'reference', 'images', 'preworld', 'char-create-ref1.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;

interface Rect { x: number; y: number; width: number; height: number }
interface ViewState {
  step: number; heritage: number; gender: number;
  view: { heading: number; position: number[]; target: number[]; zoomedIn: boolean; lit: Record<string, boolean>; animating: boolean; rotating: boolean; direction: string | null; idle: boolean } | null;
  buttons: Array<{ key: string; element: string; state: string; media: string; image: boolean; tooltip: string; rect: number[] }>;
  group: number[] | null; canvasCursor: string | null; hovered: string | null;
}

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const px = (s) => parseFloat(s) || 0;
  const ui = window.__ac && window.__ac.gameUI;
  const v = ui && ui.chargenAppearanceView;
  const group = document.querySelector('.chargen-view-buttons');
  const canvas = document.querySelector('.chargen-preview-canvas');
  const hov = ui && ui.chargenTooltipHover;
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    heritage: ui && ui.wizard ? ui.wizard.heritage : -1, gender: ui && ui.wizard ? ui.wizard.gender : -1,
    view: v ? { heading: v.heading, position: Array.from(v.currentPosition), target: Array.from(v.targetPosition), zoomedIn: v.zoomedIn,
      lit: { ...v.lit }, animating: v.animating, rotating: v.rotating, direction: v.rotateDirection, idle: v.idleAnimation } : null,
    buttons: Array.from(document.querySelectorAll('.chargen-view-btn')).map((b) => ({
      key: b.dataset.viewBtn, element: b.dataset.element, state: b.dataset.acState, media: b.dataset.acMedia, image: !!b.style.backgroundImage,
      tooltip: b.dataset.acTooltip, rect: [px(b.style.left), px(b.style.top), px(b.style.width), px(b.style.height)] })),
    group: group ? [px(group.style.left), px(group.style.top), px(group.style.width), px(group.style.height)] : null,
    canvasCursor: canvas ? canvas.style.cursor : null,
    hovered: hov && hov.entered ? (hov.entered.dataset.acTooltip || null) : null,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number, reloadEveryMs = 60_000): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > reloadEveryMs) {
      console.log('[core17kbbae] still waiting — reloading');
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
  const shoot = async (name: string, note?: string): Promise<ViewState> => {
    const file = `ours-${name}.png`;
    // The state is read right before the frame so a moving camera / heading
    // is recorded with the shot it belongs to.
    const st = await page.evaluate(STATE_JS) as ViewState;
    await page.screenshot({ path: join(OUT, file), timeout: 150_000 });
    screens[name] = { file, state: st, note };
    const v = st.view;
    console.log(`[core17kbbae] ${file}: step ${st.step} h${st.heritage} g${st.gender} ${v ? `heading ${v.heading.toFixed(1)} pos (${v.position.map((n) => n.toFixed(2)).join(', ')}) zoomedIn ${v.zoomedIn} lit ${Object.entries(v.lit).filter(([, b]) => b).map(([k]) => k).join('+') || '-'} anim ${v.animating} rot ${v.rotating}` : 'no view'} buttons ${st.buttons.map((b) => `${b.key}:${b.state}`).join(' ')}`);
    return st;
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const clickById = (id: string): Promise<boolean> => clickSel(`#${id}`);
  const currentStep = async (): Promise<number> => page.evaluate(`parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)`) as Promise<number>;
  const viewBtn = (key: string): string => `.chargen-view-btn[data-view-btn="${key}"]`;
  /** Two animation frames: Chromium delivers mouse moves rAF-aligned, and a SwiftShader frame can take most of a second while the view ticks. */
  const settle = async (): Promise<void> => { await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {}); };
  /** The real mouse on the centre of `sel` (hover state 2 / 7, the tooltip after 0.25 s). */
  const hover = async (sel: string, settleMs = 700): Promise<boolean> => {
    const c = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`) as [number, number] | null;
    if (!c) { console.log(`[core17kbbae] no element for ${sel}`); return false; }
    await page.mouse.move(c[0] - 6, c[1] + 3, { steps: 4 });
    await page.mouse.move(c[0], c[1], { steps: 3 });
    await settle();
    await page.waitForTimeout(settleMs);
    return true;
  };
  /** A real press + release on the button (UIElement_Button::MouseUp → message 1). */
  const press = async (sel: string): Promise<boolean> => {
    if (!(await hover(sel, 150))) return false;
    await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up();
    return true;
  };
  const mouseAway = async (): Promise<void> => {
    await page.mouse.move(OFF_X + 400 * SCALE, OFF_Y + 590 * SCALE, { steps: 3 });
    await settle();
    await page.waitForTimeout(250);
  };
  const next = async (): Promise<void> => {
    const before = await currentStep();
    await mouseAway();
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

  console.log('[core17kbbae] navigating (autoenter=false)');
  await page.goto(`${BASE}&autoenter=false&cb=kbbae`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const up = await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000);
  if (!up) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickById('btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3; i++) await next(); // heritage → profession → skills → appearance
  if (await currentStep() !== 3) await gotoStep(3);
  await page.waitForTimeout(2500);
  await shoot('appearance-initial', 'InitializePage: the face camera, heading 180, no button lit');

  // Rotate clockwise: hover (state 2), press (state 6 + rotating), two shots while it turns, press again (stopped, state 1).
  await hover(viewBtn('rotateClockwise'));
  await shoot('appearance-rotate-cw-hover', 'the mouse on 0x10000323: state 2 (0x06004d52) + its tooltip after 0.25 s');
  await press(viewBtn('rotateClockwise'));
  await mouseAway();
  await page.waitForTimeout(500);
  await shoot('appearance-rotate-cw-a', 'rotating clockwise (120°/s) — first shot');
  await page.waitForTimeout(700);
  await shoot('appearance-rotate-cw-b', 'rotating clockwise — second shot');
  await press(viewBtn('rotateClockwise'));
  await mouseAway();
  await page.waitForTimeout(400);
  const stopped = await shoot('appearance-rotate-cw-stopped', 'the second press stops it and unlights 0x10000323');
  const stoppedHeading = stopped.view?.heading ?? -1;
  await page.waitForTimeout(600);
  const still = await page.evaluate(STATE_JS) as ViewState;
  screens['appearance-rotate-cw-stopped'].note += ` — heading ${stoppedHeading.toFixed(1)} then ${still.view?.heading.toFixed(1)} 0.6 s later`;

  // Counter-clockwise: lit, the heading falls; then clockwise while it runs (the ccw button clears).
  await press(viewBtn('rotateCounterClockwise'));
  await mouseAway();
  await page.waitForTimeout(500);
  await shoot('appearance-rotate-ccw', 'rotating counter-clockwise (0x10000324 lit 0x06005da8)');
  await press(viewBtn('rotateClockwise'));
  await mouseAway();
  await page.waitForTimeout(300);
  await shoot('appearance-rotate-switch', 'the clockwise press while ccw runs: ccw cleared, cw lit, direction swapped');
  await press(viewBtn('rotateClockwise'));
  await mouseAway();
  await page.waitForTimeout(300);

  // Zoom: in (lit, the face — already there), out (the 0.6 s lerp to the full body), in again.
  await press(viewBtn('zoomIn'));
  await mouseAway();
  await page.waitForTimeout(900);
  await shoot('appearance-zoom-in', 'ZoomIn: 0x10000325 lit (0x06004d56), the face camera, the idle animation stopped');
  await press(viewBtn('zoomOut'));
  await mouseAway();
  await page.waitForTimeout(180);
  await shoot('appearance-zoom-out-mid', 'ZoomOut: mid-lerp toward (0, −2.5, 0.95)');
  await page.waitForTimeout(1200);
  await shoot('appearance-zoom-out', 'ZoomOut done: the full-body camera, 0x10000326 lit (0x06004d58)');
  await hover(viewBtn('zoomOut'));
  await shoot('appearance-zoom-out-hover', 'the mouse on the lit zoom-out: state 7 + its tooltip');
  await press(viewBtn('zoomIn'));
  await mouseAway();
  await page.waitForTimeout(1200);
  await shoot('appearance-zoom-in-again', 'ZoomIn from the full body: back on the face, zoom-in lit');
  await press(viewBtn('zoomOut'));
  await mouseAway();
  await page.waitForTimeout(1200);
  await clickSel('.gender-btn[data-gender="2"]');
  await page.waitForTimeout(1800);
  await shoot('appearance-gender-female', 'the gender button: SetGender + Update — the camera back on the face while zoomed out (zoom-out still lit)');

  // Heritage variants: Aun Tumerok (7) and Olthoi Soldier (12).
  await gotoStep(0);
  await clickSel('.heritage-btn[data-heritage="7"]');
  await page.waitForTimeout(800);
  await gotoStep(3);
  await page.waitForTimeout(2500);
  await shoot('appearance-tumerok', 'Aun Tumerok: the face camera (0, −0.85, 1.65)');
  await gotoStep(0);
  await clickSel('.heritage-btn[data-heritage="12"]');
  await page.waitForTimeout(800);
  await gotoStep(3);
  await page.waitForTimeout(2500);
  await shoot('appearance-olthoi', 'Olthoi Soldier: the face camera (0, −1.85, 1.85)');
  await press(viewBtn('zoomIn'));
  await mouseAway();
  await page.waitForTimeout(900);
  await press(viewBtn('zoomOut'));
  await mouseAway();
  await page.waitForTimeout(1200);
  await shoot('appearance-olthoi-zoomed-out', 'Olthoi Soldier zoomed out: (0, −3.8, 1.15)');

  // The summary page shares gmCG3DView's light.
  await gotoStep(0);
  await clickSel('.heritage-btn[data-heritage="1"]');
  await page.waitForTimeout(800);
  await gotoStep(5);
  await page.waitForTimeout(2500);
  await shoot('summary', 'the summary view 0x10000406 under the same DISTANT_LIGHT 2.0 + 0.3 ambient');

  await clickById('btn-cancel');
  await page.waitForTimeout(500);
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
    const v = s.state?.view;
    return v ? ` — heading ${v.heading.toFixed(1)}, camera (${v.position.map((x: number) => x.toFixed(2)).join(', ')}), zoomedIn ${v.zoomedIn}, lit ${Object.entries(v.lit).filter(([, b]) => b).map(([k]) => k).join('+') || 'none'}` : '';
  };
  // Layout rects in 800x600 (content y = layout y).
  const VIEW_FRAME: Rect = { x: 524, y: 72, width: 265, height: 395 };
  const VIEW_BUTTONS: Rect = { x: 554, y: 461, width: 194, height: 109 };
  const VIEW_ALL: Rect = { x: 520, y: 70, width: 275, height: 500 };
  const REF_VIEW: Rect = { x: 250, y: 70, width: 265, height: 450 };
  const SUMMARY_VIEW: Rect = { x: 575, y: 82, width: 220, height: 460 };
  const shots = ['appearance-initial', 'appearance-rotate-cw-hover', 'appearance-rotate-cw-a', 'appearance-rotate-cw-b', 'appearance-rotate-cw-stopped', 'appearance-rotate-ccw', 'appearance-rotate-switch', 'appearance-zoom-in', 'appearance-zoom-out-mid', 'appearance-zoom-out', 'appearance-zoom-out-hover', 'appearance-zoom-in-again', 'appearance-gender-female', 'appearance-tumerok', 'appearance-olthoi', 'appearance-olthoi-zoomed-out'];
  const html = `${CSS}<h1>CORE.17.k.b.b.a.e — chargen appearance page 0x21000049: the 3D view 0x100003bb from gmCGAppearancePage's face camera at heading 180 (facing the camera), the 0x2100004c:0x10000322 rotate / zoom buttons in 0x100003bc, DoRotation (3 s/turn) / ZoomIn / ZoomOut (0.6 s lerp), gmCG3DView's DISTANT_LIGHT 2.0 + 0.3 ambient. Retail heritage frame (the EoL 3D view on file) | before (the model's back, full body) | after; whole pages then crops.</h1>
    <div class="row">${frame(REF_HERITAGE, 'reference char-create-ref1.png (600x450, retail heritage page — its 3D view: a front-lit character facing the camera; the appearance page has no EoL screenshot on file)', 600)}</div>
    <div class="row">${frame(BEFORE_APPEARANCE, 'before — appearance (CORE.17.k.b.b.a.b close capture: the BACK of the model at an invented 30° full-body camera; drag / wheel)')}${frame(ours('appearance-initial'), `after — appearance${noteOf('appearance-initial')}`)}</div>
    <h2>the 3D view: retail heritage view | before | after (InitializePage: face camera (0, −0.55, 1.65), heading 180) — 1.2x</h2>
    <div class="row">${cropRef(REF_VIEW, 'retail — heritage page 3D view (full body, facing the camera, lit from the front)', 1.2)}${cropOurs(BEFORE_APPEARANCE, VIEW_ALL, 'before — the back, no working buttons', 1.2)}${cropOurs(ours('appearance-initial'), VIEW_ALL, 'after — the face at heading 180; the 0x10000322 buttons in state 1', 1.2)}</div>
    <h2>rotate: hover 0x10000323 (state 2) | pressed and turning clockwise (state 6, 120°/s) | turning | the second press stops it (state 1) — 1.2x</h2>
    <div class="row">${['appearance-rotate-cw-hover', 'appearance-rotate-cw-a', 'appearance-rotate-cw-b', 'appearance-rotate-cw-stopped'].map((n) => cropOurs(ours(n), VIEW_ALL, `${n}${noteOf(n)}`, 1.2)).join('')}</div>
    <h2>counter-clockwise (0x10000324 lit) | the clockwise press while it runs (ccw cleared, cw lit) — 1.2x</h2>
    <div class="row">${['appearance-rotate-ccw', 'appearance-rotate-switch'].map((n) => cropOurs(ours(n), VIEW_ALL, `${n}${noteOf(n)}`, 1.2)).join('')}</div>
    <h2>zoom: in (0x10000325 lit, face) | out mid-lerp | out (full body (0, −2.5, 0.95), 0x10000326 lit) | zoom-out hovered (state 7 + tooltip) | in again — 1.2x</h2>
    <div class="row">${['appearance-zoom-in', 'appearance-zoom-out-mid', 'appearance-zoom-out', 'appearance-zoom-out-hover', 'appearance-zoom-in-again'].map((n) => cropOurs(ours(n), VIEW_ALL, `${n}${noteOf(n)}`, 1.2)).join('')}</div>
    <h2>the gender button (Update: camera back on the face, zoom-out still lit) | Aun Tumerok (0, −0.85, 1.65) | Olthoi Soldier (0, −1.85, 1.85) | Olthoi zoomed out (0, −3.8, 1.15) — 1.2x</h2>
    <div class="row">${['appearance-gender-female', 'appearance-tumerok', 'appearance-olthoi', 'appearance-olthoi-zoomed-out'].map((n) => cropOurs(ours(n), VIEW_ALL, `${n}${noteOf(n)}`, 1.2)).join('')}</div>
    <h2>the button group 0x100003bc (560,467) 182x97 — states 1 | cw hover 2 | cw lit 6 | zoom-in lit 6 | zoom-out lit 6 | zoom-out lit + hover 7 — 3x</h2>
    <div class="row">${['appearance-initial', 'appearance-rotate-cw-hover', 'appearance-rotate-cw-a', 'appearance-zoom-in', 'appearance-zoom-out', 'appearance-zoom-out-hover'].map((n) => cropOurs(ours(n), VIEW_BUTTONS, n, 3)).join('')}</div>
    <h2>the summary view 0x10000406 under the shared gmCG3DView light — before (CORE.17.k.b.b.a.c close: invented ambient 0.65 + (1, 2, 3) 0.85) | after (0.3 ambient + DISTANT_LIGHT 2.0 along (0.3, 1.9, 0.65)) — 1.2x</h2>
    <div class="row">${cropOurs(BEFORE_SUMMARY, SUMMARY_VIEW, 'before — summary view', 1.2)}${cropOurs(ours('summary'), SUMMARY_VIEW, 'after — summary view', 1.2)}</div>
    <h2>whole pages</h2>
    ${shots.filter((n) => existsSync(ours(n))).map((n) => `<div class="row">${frame(ours(n), `${n}${noteOf(n)}`, 900)}</div>`).join('')}
    <div class="row">${frame(BEFORE_SUMMARY, 'before — summary (CORE.17.k.b.b.a.c close capture)')}${frame(ours('summary'), 'after — summary')}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbae-appearance-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbae] wrote ${join(OUT, 'core17kbbae-appearance-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
