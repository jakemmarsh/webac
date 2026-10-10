/**
 * CORE.17.k.b.b.a.e.a.a — live capture: the chargen summary view's idle loop
 * starts ONCE per chargen session (gmCGSummaryPage::InitializePage — the
 * StartAnimation caller — runs only from the gmCharGenMainUI ctor), keeps
 * running across Summary visits, and is gone for good once
 * gmCG3DView::Update replaced the view object for a new setup (a
 * sequence-less makeObject on placement frame 0).
 *
 * Pass (Playwright / SwiftShader against the local ACE stack): char select →
 * Create Character → Summary (Aluvian male = HUMAN_SETUP_ID): two shots,
 * the summary animator's frame recorded; back to Town ~1 s, forward to
 * Summary: the frame CONTINUES (before the fix it was 0 — the loop
 * restarted); the appearance page detour (its own view restarts, the
 * summary's does not); Sho male (same setup): still running; Olthoi
 * Soldier (setup 0x02001a21): the object replaced — no sequence, two shots
 * with a zero canvas delta; back to Aluvian: still no sequence.
 *
 *   npx tsx tools/capture-core17kbbaeaa-summary-animation-once.ts [--compose-only]
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbaeaa');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;

interface ShotState {
  step: number; heritage: number; gender: number;
  anim: { mode: string | null; id: string; frame: number; playing: boolean } | null;
  object: { setup: string; live: boolean } | null;
  canvasDelta: number; canvasNonBlank: number;
}

const STATE_JS = `(() => {
  const ui = window.__ac && window.__ac.gameUI;
  const a = ui && ui.chargenSummaryAnimator;
  const o = ui && ui.chargenSummaryObject;
  const canvas = document.querySelector('.chargen-summary-canvas') || document.querySelector('.chargen-preview-canvas');
  let delta = -1, nonBlank = 0;
  if (canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const prev = window.__kbbaeaaPrev;
    if (prev && prev.length === d.length) { delta = 0; for (let i = 0; i < d.length; i++) { const x = d[i] - prev[i]; delta += x < 0 ? -x : x; } }
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonBlank++;
    window.__kbbaeaaPrev = d;
  }
  return {
    step: parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10),
    heritage: ui && ui.wizard ? ui.wizard.heritage : -1, gender: ui && ui.wizard ? ui.wizard.gender : -1,
    anim: a ? { mode: a.currentMode, id: '0x' + a.currentAnimationId.toString(16), frame: a.frame, playing: a.playing } : null,
    object: o ? { setup: '0x' + o.setupId.toString(16), live: o.sequenceLive } : null,
    canvasDelta: delta, canvasNonBlank: nonBlank,
  };
})()`;

async function waitFor(page: Page, js: string, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now(); let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(js).catch(() => false)) return true;
    if (Date.now() - lastReload > 60_000) { await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); lastReload = Date.now(); }
    await page.waitForTimeout(2500);
  }
  return false;
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  const shots: Record<string, { file: string; state: ShotState; note: string }> = {};
  // Hold the UI tick for the screenshot (SwiftShader starves the compositor under a 30 fps offscreen loop), resume after.
  const HOLD_JS = `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.chargenAppearanceTick) { cancelAnimationFrame(ui.chargenAppearanceTick); ui.chargenAppearanceTick = 0; return true; } return false; })()`;
  const RESUME_JS = `(() => { const ui = window.__ac && window.__ac.gameUI; if (ui && ui.startChargenViewTicks) ui.startChargenViewTicks(); })()`;
  const shoot = async (name: string, note: string): Promise<ShotState> => {
    const st = await page.evaluate(STATE_JS) as ShotState;
    const held = await page.evaluate(HOLD_JS).catch(() => false);
    const file = `ours-${name}.png`;
    await page.screenshot({ path: join(OUT, file), timeout: 150_000 });
    if (held) await page.evaluate(RESUME_JS).catch(() => {});
    shots[name] = { file, state: st, note };
    const a = st.anim;
    console.log(`[kbbaeaa] ${file}: step ${st.step} h${st.heritage} g${st.gender} ${a ? `${a.mode} ${a.id} frame ${a.frame.toFixed(2)} playing ${a.playing}` : 'no animator'} object ${st.object ? `${st.object.setup} live ${st.object.live}` : '-'} Δ ${st.canvasDelta} nonBlank ${st.canvasNonBlank}`);
    return st;
  };
  const probe = async (): Promise<ShotState> => page.evaluate(STATE_JS) as Promise<ShotState>;
  /** Render the step; returns the summary animator's frame read synchronously before and right after the render (a restart reads exactly 0 after). */
  const entryFrames: Array<{ step: number; before: number | null; after: number | null }> = [];
  const gotoStep = async (step: number, waitMs = 1500): Promise<void> => {
    const f = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const a0 = ui.chargenSummaryAnimator; const before = a0 ? a0.frame : null; ui.wizard.currentStep = ${step}; ui.renderCharacterCreate(); const a = ui.chargenSummaryAnimator; return { before, after: a ? a.frame : null }; })()`) as { before: number | null; after: number | null };
    if (step === 5) { entryFrames.push({ step, ...f }); console.log(`[kbbaeaa] Summary entry: frame ${f.before} → ${f.after} across the render`); }
    await page.waitForTimeout(waitMs);
  };
  const clickSel = async (sel: string): Promise<boolean> => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
  const heritage = async (h: number): Promise<void> => { await gotoStep(0, 600); await clickSel(`.heritage-btn[data-heritage="${h}"]`); await page.waitForTimeout(600); };

  await page.goto(`${BASE}&autoenter=false&cb=kbbaeaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  if (!(await waitFor(page, `document.getElementById('charsel-inner')?.dataset.mode === 'select'`, 360_000))) throw new Error('character select never appeared');
  await page.waitForTimeout(1500);
  if (!(await clickSel('#btn-create-character'))) throw new Error('#btn-create-character not found');
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(1500);

  await gotoStep(5, 2500);
  await probe();
  const first = await shoot('summary-first-a', 'first Summary entry (Aluvian male, HUMAN_SETUP_ID): the loop runs');
  await page.waitForTimeout(700);
  const firstB = await shoot('summary-first-b', 'the same visit 0.7 s later');
  await gotoStep(4, 1000);
  await gotoStep(5, 300);
  const back = await shoot('summary-reentry', 'Town → Summary again: the sequence CONTINUES (retail: InitializePage is not re-run)');
  await gotoStep(3, 1500);
  await gotoStep(5, 300);
  const detour = await shoot('summary-after-appearance', 'after an appearance-page detour: the summary loop still continues');
  await heritage(3);
  await gotoStep(5, 300);
  const sho = await shoot('summary-sho', 'Sho male — the same setup 0x02000001: the object and its sequence survive');
  await heritage(12);
  await gotoStep(5, 2500);
  await probe();
  const olA = await shoot('summary-olthoi-a', 'Olthoi Soldier (setup 0x02001a21): gmCG3DView::Update makeObject — no sequence, placement frame 0');
  await page.waitForTimeout(1200);
  const olB = await shoot('summary-olthoi-b', '1.2 s later: still (Δpx 0)');
  await heritage(1);
  await gotoStep(5, 2500);
  await probe();
  const alA = await shoot('summary-aluvian-again-a', 'back to Aluvian male: the setup changed again → another fresh object, still no sequence');
  await page.waitForTimeout(1200);
  const alB = await shoot('summary-aluvian-again-b', '1.2 s later: still');
  const summary = {
    capturedAt: new Date().toISOString(),
    firstFrames: [first.anim?.frame, firstB.anim?.frame],
    reentryFrame: back.anim?.frame, afterAppearanceFrame: detour.anim?.frame, shoFrame: sho.anim?.frame,
    entryFrames, olthoiDelta: olB.canvasDelta, aluvianAgainDelta: alB.canvasDelta, olthoiLive: olA.object?.live, aluvianAgainLive: alA.object?.live,
    shots,
  };
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(summary, null, 2));
  await browser.close();
}

function dataUrl(file: string): string { return `data:image/png;base64,${readFileSync(file).toString('base64')}`; }

async function compose(): Promise<void> {
  const live = JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8'));
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 1900, height: 900 } });
  const r = { x: OFF_X + 575 * SCALE, y: OFF_Y + 82 * SCALE, width: 220 * SCALE, height: 460 * SCALE };
  const zoom = 1.2 / SCALE;
  const cell = (name: string): string => {
    const s = live.shots[name];
    if (!s || !existsSync(join(OUT, s.file))) return `<div class="cell">${name}: (no capture)</div>`;
    const a = s.state.anim;
    const lbl = `${name}<br>${s.note}<br>${a ? `${a.mode ?? 'no sequence'} ${a.id} frame ${a.frame.toFixed(1)}` : 'no animator'} · Δpx ${s.state.canvasDelta}`;
    return `<div class="cell"><div class="lbl">${lbl}</div><div class="crop" style="width:${Math.round(r.width * zoom)}px;height:${Math.round(r.height * zoom)}px"><img src="${dataUrl(join(OUT, s.file))}" style="left:${-r.x * zoom}px;top:${-r.y * zoom}px;width:${VIEW.width * zoom}px;height:${VIEW.height * zoom}px"/></div></div>`;
  };
  const html = `<style>body{margin:0;background:#1a1a1a;color:#eee;font:12px/1.3 monospace;padding:10px}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}.cell{display:flex;flex-direction:column;gap:4px;max-width:280px}.lbl{color:#ffd;min-height:70px}.crop{position:relative;overflow:hidden;border:1px solid #444}.crop img{position:absolute}h1{font-size:13px}</style>
  <h1>CORE.17.k.b.b.a.e.a.a — the summary view 0x10000406: StartAnimation once per chargen session (the gmCharGenMainUI ctor), continuing across visits; a setup change → a sequence-less object (placement frame 0) for good. Frames: first ${live.firstFrames.map((f: number) => f?.toFixed(1)).join(' → ')}, re-entry ${live.reentryFrame?.toFixed(1)}, after the appearance page ${live.afterAppearanceFrame?.toFixed(1)}, Sho ${live.shoFrame?.toFixed(1)}; Olthoi Δpx ${live.olthoiDelta}, Aluvian-again Δpx ${live.aluvianAgainDelta}.</h1>
  <div class="row">${['summary-first-a', 'summary-first-b', 'summary-reentry', 'summary-after-appearance', 'summary-sho'].map(cell).join('')}</div>
  <div class="row">${['summary-olthoi-a', 'summary-olthoi-b', 'summary-aluvian-again-a', 'summary-aluvian-again-b'].map(cell).join('')}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17kbbaeaa-summary-once.png'), fullPage: true });
  await browser.close();
  console.log(`[kbbaeaa] wrote ${join(OUT, 'core17kbbaeaa-summary-once.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
