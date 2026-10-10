/**
 * CORE.17.k.b.b.a.a.a — live verification of the loading (patch) screen's
 * meter label TEXTS on the ACE stack: the connect label follows
 * gmDataPatchUI::SetConnectLevel's state ("Connect progress" at 0.0,
 * "Connected!" at 1.0 once the bridge answers), the patch label the DDD
 * strings of OnDDDEvent ("Looking for data to patch...", "Patching
 * data...", "<n>% of <total>K complete...", "Patching Done!") with the
 * browser's DAT download as the data patch.
 *
 * Runs (each in its own browser context = its own OPFS cache):
 *   cold   — every DAT from the network; the cell DAT's requests are held
 *            so the screen sits mid-patch ("72% of 1,246,208K complete..."
 *            with the connect meter at "Connected!"); then the requests are
 *            released and `weenie-setups.json` is held so the screen sits on
 *            "Patching Done!" at 100 %.
 *   warm   — a second load in the SAME context: with the DATs OPFS-cached the
 *            interrogation finds nothing to download ("Looking for data to
 *            patch..." → "Patching Done!", no "Patching data..."); a headless
 *            context whose OPFS quota refuses the 1.3 GB writes re-downloads,
 *            and the caption reports which happened (weenie-setups.json held).
 *   nobridge — `bridge=ws://localhost:9` (nothing listening): the connect
 *            label stays "Connect progress" at 0 — the level the ctor sets
 *            and UseTime never raises.
 * The compose step writes verification/core17kbbaaa/core17kbbaaa-patch-labels-sidebyside.png:
 * the previous build's frame (verification/core17kbbaa/ours-splash.png:
 * "Connected!" from a scripted animation + "Loading cell.dat...") next to
 * each run's frame, with 2x crops of the meter row, and the DAT strings.
 *
 * Usage: npx tsx tools/capture-core17kbbaaa-patch-labels-sidebyside.ts [--compose-only]
 */
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbaaa');
const BEFORE_FRAME = join(REPO, 'verification', 'core17kbbaa', 'ours-splash.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
/** The pre-world 800x600 frame letterboxed into the viewport (attachPreworldScale). */
const SCALE = Math.min(VIEW.width / 800, VIEW.height / 600);
const OFF_X = (VIEW.width - 800 * SCALE) / 2;
const OFF_Y = (VIEW.height - 600 * SCALE) / 2;

/** Layout 0x21000000: the meter row (0x1000041e/f at y 514, the labels 0x10000420/1 at y 560). */
const METER_ROW_RECT = { x: 0, y: 505, width: 800, height: 85 };
const CONNECT_LABEL_RECT = { x: 28, y: 560, width: 354, height: 20 };
const PATCH_LABEL_RECT = { x: 408, y: 560, width: 354, height: 20 };

interface Rect { x: number; y: number; width: number; height: number }

function launch(): Promise<Browser> {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

const STATE_JS = `(() => {
  const el = (id) => document.getElementById(id);
  const ds = (e) => e ? { ...e.dataset } : null;
  const overlay = el('loading-overlay');
  const label = (id) => { const e = el(id); if (!e) return null; const run = e.firstElementChild; return { text: e.dataset.acText ?? e.textContent, dataset: ds(e), run: run ? { tag: run.tagName, width: run.width ?? null, height: run.height ?? null, dataset: ds(run) } : null }; };
  const meters = Array.from(overlay ? overlay.querySelectorAll('canvas') : []).filter((c) => c.width === 325 && c.height === 46);
  return {
    overlayPresent: !!overlay,
    datSplash: !!(overlay && overlay.querySelector('img')),
    connect: label('load-text-left'),
    patch: label('load-text-right'),
    meterCanvases: meters.length,
  };
})()`;

type Screens = Record<string, { file: string; live: unknown }>;

async function preparePage(page: Page, pageLog: string[]): Promise<void> {
  page.on('dialog', (d) => void d.dismiss());
  page.on('console', (m) => {
    if (!/\[AC\] (patch screen|patch|epilogue|Fatal)|\[AC:DatCache\]/i.test(m.text())) return;
    pageLog.push(m.text().slice(0, 200));
    console.log(`  [page] ${m.text().slice(0, 160)}`);
  });
}

async function shoot(page: Page, screens: Screens, file: string): Promise<void> {
  await page.screenshot({ path: join(OUT, file) });
  screens[file.replace(/\.png$/, '')] = { file, live: await page.evaluate(STATE_JS) };
  const live = screens[file.replace(/\.png$/, '')].live as { connect?: { text?: string }; patch?: { text?: string } };
  console.log(`[core17kbbaaa] ${file}  connect="${live.connect?.text ?? ''}"  patch="${live.patch?.text ?? ''}"`);
}

/** Wait until the right label's text matches `re` (the placeholder or the DAT-drawn cell). */
async function waitForPatchText(page: Page, re: RegExp, timeout: number): Promise<void> {
  await page.waitForFunction((src: string) => {
    const e = document.getElementById('load-text-right');
    const t = e ? (e.dataset.acText ?? e.textContent ?? '') : '';
    return new RegExp(src).test(t);
  }, re.source, { timeout });
}

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const state: Record<string, unknown> = { capturedAt: new Date().toISOString(), viewport: VIEW, scale: SCALE, runs: {} };
  const runs = state.runs as Record<string, { screens: Screens; pageLog: string[] }>;

  // ── cold + warm: one context (its OPFS cache carries over) ──────────
  {
    const context = await browser.newContext({ viewport: VIEW });
    const page = await context.newPage();
    const pageLog: string[] = [];
    await preparePage(page, pageLog);
    const screens: Screens = {};
    runs.cold = { screens, pageLog };

    // Hold the cell DAT's requests: the interrogation's HEAD must pass (the
    // byte total needs it), only the GET is held so the patch sits at the
    // portal's share of the total.
    const heldCell: Route[] = [];
    await page.route('**/client_cell_1.dat*', (route) => {
      if (route.request().method() === 'GET') heldCell.push(route); else route.continue();
    });
    const heldSetups: Route[] = [];
    await page.route('**/weenie-setups.json*', (route) => { heldSetups.push(route); });

    console.log('[core17kbbaaa] cold: navigating (fresh context, every DAT from the network)');
    await page.goto(`${BASE}&autoenter=false&cb=kbbaaa`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    // The placeholder overlay first: the ctor's texts, then the interrogation.
    await page.waitForFunction(() => !!document.getElementById('load-text-left')?.textContent, undefined, { timeout: 30_000 });
    await shoot(page, screens, 'cold-placeholder.png');
    // The DAT splash replaces the placeholder once portal.dat is parsed; the
    // cell GET is held, so the label reads the portal's share of the total.
    await page.waitForFunction(() => !!document.querySelector('#loading-overlay img'), undefined, { timeout: 300_000 });
    await waitForPatchText(page, /% of [\d,]+K complete\.\.\./, 30_000);
    await page.waitForTimeout(1500);
    await shoot(page, screens, 'cold-patching.png');
    // Release the cell DAT; the language DAT follows; weenie-setups.json is
    // held so the screen sits on "Patching Done!".
    for (const r of heldCell) r.continue().catch(() => {});
    await waitForPatchText(page, /^Patching Done!$/, 300_000);
    await page.waitForTimeout(800);
    await shoot(page, screens, 'cold-done.png');
    state.coldHeld = { cell: heldCell.length, setups: heldSetups.length };
    for (const r of heldSetups) r.continue().catch(() => {});
    // Let the OPFS writes settle before the warm reload.
    await page.waitForFunction(() => !document.getElementById('loading-overlay'), undefined, { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(6000);

    // ── warm: the same context, DATs cached ───────────────────────────
    const warmLog: string[] = [];
    const warmScreens: Screens = {};
    runs.warm = { screens: warmScreens, pageLog: warmLog };
    pageLog.length = 0;
    const page2 = await context.newPage();
    await preparePage(page2, warmLog);
    const heldSetups2: Route[] = [];
    await page2.route('**/weenie-setups.json*', (route) => { heldSetups2.push(route); });
    console.log('[core17kbbaaa] warm: navigating (same context — OPFS cache)');
    await page2.goto(`${BASE}&autoenter=false&cb=kbbaaa2`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page2.waitForFunction(() => !!document.querySelector('#loading-overlay img'), undefined, { timeout: 300_000 });
    await waitForPatchText(page2, /^Patching Done!$/, 300_000);
    await page2.waitForTimeout(800);
    await shoot(page2, warmScreens, 'warm-done.png');
    for (const r of heldSetups2) r.continue().catch(() => {});
    await page.close().catch(() => {});
    await page2.close().catch(() => {});
    await context.close();
  }

  // ── nobridge: nothing listening on the bridge port ─────────────────
  {
    const context = await browser.newContext({ viewport: VIEW });
    const page = await context.newPage();
    const pageLog: string[] = [];
    await preparePage(page, pageLog);
    const screens: Screens = {};
    runs.nobridge = { screens, pageLog };
    const heldCell: Route[] = [];
    await page.route('**/client_cell_1.dat*', (route) => {
      if (route.request().method() === 'GET') heldCell.push(route); else route.continue();
    });
    const url = BASE.replace(/bridge=ws:\/\/[^&]+/, 'bridge=ws://localhost:9');
    console.log('[core17kbbaaa] nobridge: navigating (bridge=ws://localhost:9)');
    await page.goto(`${url}&autoenter=false&cb=kbbaaa3`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(() => !!document.querySelector('#loading-overlay img'), undefined, { timeout: 300_000 });
    await waitForPatchText(page, /% of [\d,]+K complete\.\.\./, 30_000);
    await page.waitForTimeout(4000); // past the probe's 3 s timeout
    await shoot(page, screens, 'nobridge-patching.png');
    for (const r of heldCell) r.abort().catch(() => {});
    await context.close();
  }

  await browser.close();
  writeFileSync(join(OUT, 'live-state.json'), JSON.stringify(state, null, 2));
}

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}
function cropOf(file: string, rect: Rect, label: string, zoom: number): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><div class="crop" style="width:${Math.round(rect.width * zoom)}px;height:${Math.round(rect.height * zoom)}px"><img src="${dataUrl(file)}" style="left:${-rect.x * zoom}px;top:${-rect.y * zoom}px;width:${VIEW.width * zoom}px;height:${VIEW.height * zoom}px"/></div></div>`;
}
/** A DAT 800x600 rect → the letterboxed frame. */
function frameRect(dat: Rect): Rect {
  return { x: OFF_X + dat.x * SCALE, y: OFF_Y + dat.y * SCALE, width: dat.width * SCALE, height: dat.height * SCALE };
}
function crop(file: string, dat: Rect, label: string, zoom: number): string {
  return cropOf(file, frameRect(dat), label, zoom / SCALE);
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
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:3px 8px;text-align:left;font-size:12px}
</style>`;

async function compose(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const live = existsSync(join(OUT, 'live-state.json')) ? JSON.parse(readFileSync(join(OUT, 'live-state.json'), 'utf8')) : { runs: {} };
  const text = (run: string, screen: string, side: 'connect' | 'patch'): string =>
    live.runs?.[run]?.screens?.[screen]?.live?.[side]?.text ?? '(n/a)';
  const o = (n: string) => join(OUT, n);
  // What the warm reload actually found: the page log's interrogation line
  // ("N of M DATs to download") — a headless context whose OPFS quota
  // refused the 1.3 GB writes downloads again, and the caption says so.
  const warmNote = (st: { runs?: Record<string, { pageLog?: string[] }> }): string => {
    const line = st.runs?.warm?.pageLog?.find((l) => /DATs to download/.test(l));
    const m = line?.match(/(\d+) of (\d+) DATs to download/);
    if (!m) return 'interrogation result unknown';
    return m[1] === '0' ? 'every DAT OPFS-cached — nothing to patch: Interrogation → PatchtimeEnd' : `${m[1]} of ${m[2]} DATs re-downloaded — the headless OPFS quota refused the cache writes`;
  };
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2200, height: 900 } });
  const html = `${CSS}<h1>CORE.17.k.b.b.a.a.a — loading screen 0x21000000 (gmDataPatchUI): the meter label TEXTS. 0x10000420 = SetConnectLevel's state (0.0 → 73246003 "Connect progress", 1.0 → 184756820 "Connected!"; the EoL binary never passes the 0&lt;level&lt;1 that selects 3318519 "Connecting..."). 0x10000421 = the ID_DataPatch_* strings OnDDDEvent @ 004edff0 sets from table 0x23000002: 20083534 "Looking for data to patch...", 61383143 "Patching data...", 56886563 "&lt;percent&gt;% of &lt;total&gt;K complete..." (token_percent = trunc(level*100), token_total = expected &gt;&gt; 10, NumToString grouping 3 ","), 31989477 "Patching Done!". The browser's DAT download is the data patch. No retail frame of the patch screen is on file — the DAT + decomp are the ground truth.</h1>
    <div class="row">${frame(BEFORE_FRAME, 'before — previous build: "Connected!" from a scripted 0.5 s animation with no server contact, "Loading cell.dat..." (invented) on the patch label')}${frame(o('cold-patching.png'), `after — cold load, mid-patch: connect "${text('cold', 'cold-patching', 'connect')}" (the bridge answered its health probe), patch "${text('cold', 'cold-patching', 'patch')}"`)}</div>
    <h2>the meter row 0x1000041e/f + labels 0x10000420/1 — 2x</h2>
    <div class="row">${crop(BEFORE_FRAME, METER_ROW_RECT, 'before', 2)}</div>
    <div class="row">${crop(o('cold-patching.png'), METER_ROW_RECT, `after — cold, mid-patch (cell DAT held): "${text('cold', 'cold-patching', 'connect')}" | "${text('cold', 'cold-patching', 'patch')}"`, 2)}</div>
    <div class="row">${crop(o('cold-done.png'), METER_ROW_RECT, `after — cold, patch complete (weenie-setups.json held): "${text('cold', 'cold-done', 'connect')}" | "${text('cold', 'cold-done', 'patch')}"`, 2)}</div>
    <div class="row">${crop(o('warm-done.png'), METER_ROW_RECT, `after — warm reload, same context (${warmNote(live)}): "${text('warm', 'warm-done', 'connect')}" | "${text('warm', 'warm-done', 'patch')}"`, 2)}</div>
    <div class="row">${crop(o('nobridge-patching.png'), METER_ROW_RECT, `after — no bridge listening: the connect level stays 0.0: "${text('nobridge', 'nobridge-patching', 'connect')}" | "${text('nobridge', 'nobridge-patching', 'patch')}"`, 2)}</div>
    <h2>labels 4x</h2>
    <div class="row">${crop(o('cold-patching.png'), CONNECT_LABEL_RECT, '0x10000420 state 0x1000003c', 4)}${crop(o('cold-patching.png'), PATCH_LABEL_RECT, '0x10000421 ID_DataPatch_PatchProgress', 4)}</div>
    <div class="row">${crop(o('nobridge-patching.png'), CONNECT_LABEL_RECT, '0x10000420 state 0x1', 4)}${crop(o('cold-done.png'), PATCH_LABEL_RECT, '0x10000421 ID_DataPatch_PatchingDone', 4)}</div>
    <h2>whole frames</h2>
    <div class="row">${frame(o('cold-placeholder.png'), `cold — the pre-DAT placeholder overlay (the ctor's texts before portal.dat exists to draw with): "${text('cold', 'cold-placeholder', 'connect')}" | "${text('cold', 'cold-placeholder', 'patch')}"`, 520)}${frame(o('cold-done.png'), 'cold — "Patching Done!" at 100 %', 520)}${frame(o('warm-done.png'), `warm — "Patching Done!" (${warmNote(live)})`, 520)}${frame(o('nobridge-patching.png'), 'no bridge — "Connect progress" at 0', 520)}</div>`;
  await page.setContent(html);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17kbbaaa-patch-labels-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbaaa] wrote ${join(OUT, 'core17kbbaaa-patch-labels-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
