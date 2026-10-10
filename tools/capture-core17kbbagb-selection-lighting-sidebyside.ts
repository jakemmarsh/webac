/**
 * CORE.17.k.b.b.a.g.b — the selected object's overhead name label is gone;
 * retail's selection feedback is the object's own lighting blink
 * (UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound @ 004e5ad0 →
 * CPhysicsObj::SetLighting(LIGHT_HIGH); Global_Loop @ 004e5620: HIGH → LOW →
 * HIGH → LOW → restore, SELECTION_FLIP_TIME = 0.2 s each) plus the toolbar's
 * selected-item field 0x1000019f. Live capture on the ACE stack + a
 * retail | before | after side-by-side.
 *
 * Beats (each a whole-screen frame + a 2x crop at the click point):
 *   idle             nothing selected
 *   select-high      the object just clicked (LIGHT_HIGH: luminosity 0.99 /
 *                    diffuse 1.0 on its part materials; before: the overhead
 *                    name label above its head, materials untouched)
 *   select-low       the first flip (LIGHT_LOW: 0.0 / 0.35)
 *   select-restored  after the fourth flip (the object's own materials back)
 *
 * SwiftShader takes ~8 s per screenshot, so the blink is frozen between
 * frames by pinning `selectionLighting.timeNextFlip` and stepping `loop()`
 * by hand; the state JSON records what each frame shows.
 *
 * Usage:
 *   npx tsx tools/capture-core17kbbagb-selection-lighting-sidebyside.ts            # capture + compose
 *   AC_URL=http://localhost:3001/?ace&... npx tsx tools/capture-core17kbbagb-selection-lighting-sidebyside.ts --before
 *   npx tsx tools/capture-core17kbbagb-selection-lighting-sidebyside.ts --compose-only
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17kbbagb');
const RETAIL = join(REPO, 'reference', 'images', 'hud', 'rawg_06.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };
const BEFORE = process.argv.includes('--before');
const PREFIX = BEFORE ? 'ours-before-' : 'ours-';

interface SelState {
  /** The selection machine (after only). */
  machine: { litGuid: number; flipCount: number; timeNextFlip: number } | null;
  /** The toolbar's selection: guid + the 0x1000019f field text. */
  target: { guid: number; name: string; field: string | null } | null;
  /** The first lit material of the selected object's mesh. */
  material: { type: string; emissive: number; color: number; copies: number | null } | null;
  /** The overhead name label (before only; null when the container is gone). */
  label: { shown: boolean; text: string } | null;
  mouse: { x: number; y: number };
}

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}
function drive(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Selection Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}
async function waitForWorld(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      let created = 'not-at-create';
      try { created = await drive(page); } catch { /* nav mid-probe */ }
      if (created !== 'not-at-create') { createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world');
}

/** The selection state as it stands (source string: tsx injects helpers a closure would drag into the page). */
const STATE_JS = `((mx, my) => {
  const ac = window.__ac;
  const sl = ac.selectionLighting || null;
  const machine = sl ? { litGuid: sl.litGuid, flipCount: sl.flipCount, timeNextFlip: sl.timeNextFlip } : null;
  const t = ac.gameUI.hudState.target;
  const h = ac.gameUI.toolbarHandle;
  const fieldEl = h && h.elements && h.elements.get(0x1000019f);
  const target = t ? { guid: t.id, name: t.name, field: fieldEl ? (fieldEl.textContent || '') : null } : null;
  let material = null;
  const obj = t ? ac.serverObjectManager.getObject(t.id) : null;
  if (obj && obj.mesh) {
    obj.mesh.traverse((c) => {
      if (material) return;
      const m = Array.isArray(c.material) ? c.material[0] : c.material;
      if (m && m.emissive) material = { type: m.type, emissive: m.emissive.r, color: m.color.r, copies: obj.lightingCopies ? obj.lightingCopies.size : null };
    });
  }
  const l = document.getElementById('name-labels'); const lab = l && l.firstElementChild;
  const label = lab ? { shown: lab.style.display !== 'none', text: lab.textContent || '' } : null;
  return { machine, target, material, label, mouse: { x: mx, y: my } };
})`;
async function selState(page: Page, mx: number, my: number): Promise<SelState> {
  return page.evaluate(`${STATE_JS}(${mx}, ${my})`) as Promise<SelState>;
}

async function shoot(page: Page, name: string, mx: number, my: number, screens: Record<string, { file: string; state: SelState }>): Promise<SelState> {
  const file = `${PREFIX}${name}.png`;
  const state = await selState(page, mx, my);
  await page.screenshot({ path: join(OUT, file) });
  screens[name] = { file, state };
  console.log(`[core17kbbagb] ${name}: ${JSON.stringify(state)}`);
  return state;
}

/** Freeze the blink (after) so the screenshot shows the current phase; before: no machine, no-op. */
const FREEZE_JS = `(() => { const sl = window.__ac.selectionLighting; if (!sl) return false; sl.timeNextFlip = 1e12; return true; })()`;
/** One due Global_Loop tick, then freeze again. */
const STEP_JS = `(() => { const sl = window.__ac.selectionLighting; if (!sl) return false; sl.loop(1e12); sl.timeNextFlip = 1e12; return true; })()`;

async function captureLive(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.on('pageerror', (e) => console.log('[page error]', e.message));
  console.log(`[core17kbbagb] ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  console.log('[core17kbbagb] in world');
  await page.waitForTimeout(6000);
  await page.mouse.move(VIEW.width / 2, 120);
  await page.waitForTimeout(500);
  const screens: Record<string, { file: string; state: SelState }> = {};
  await shoot(page, 'idle', VIEW.width / 2, 120, screens);

  // ── Sweep the 3D view for an object under the mouse (the canvas tooltip tag from CORE.17.k.b.b.a.g.a) ──
  let found: { x: number; y: number } | null = null;
  const canvasTagged = `(() => { const c = document.querySelector('canvas'); return !!(c && c.dataset.acTooltipText); })()`;
  for (const [fx, fy] of [[0.5, 0.62], [0.5, 0.55], [0.5, 0.7], [0.45, 0.6], [0.55, 0.6], [0.5, 0.5], [0.4, 0.55], [0.6, 0.55], [0.3, 0.5], [0.7, 0.5], [0.35, 0.65], [0.65, 0.65]]) {
    const x = VIEW.width * fx, y = VIEW.height * fy;
    await page.mouse.move(x, y); await page.waitForTimeout(250);
    await page.mouse.move(x + 1, y); await page.waitForTimeout(250);
    if (await page.evaluate(canvasTagged)) { found = { x: x + 1, y }; break; }
  }
  if (!found) {
    console.log('[core17kbbagb] no 3D object found under the sweep — beats skipped');
  } else {
    const name = await page.evaluate(`document.querySelector('canvas').dataset.acTooltipText`);
    console.log(`[core17kbbagb] object under the mouse at (${found.x.toFixed(0)},${found.y.toFixed(0)}): ${JSON.stringify(name)}`);
    // Move the tooltip hover away from the object first, then click it: the
    // click's raycast is sr_Select; the mouse stays put so the hover re-find
    // (sr_MouseOver on the same object) never restores it.
    await page.mouse.click(found.x, found.y);
    await page.evaluate(FREEZE_JS);
    await page.waitForTimeout(300);
    await shoot(page, 'select-high', found.x, found.y, screens);
    await page.evaluate(STEP_JS);                    // count 2 → LOW
    await page.waitForTimeout(300);
    await shoot(page, 'select-low', found.x, found.y, screens);
    await page.evaluate(STEP_JS);                    // count 3 → HIGH
    await page.evaluate(STEP_JS);                    // count 4 → LOW
    await page.evaluate(STEP_JS);                    // count 5 → restore
    await page.waitForTimeout(300);
    await shoot(page, 'select-restored', found.x, found.y, screens);
  }

  writeFileSync(join(OUT, BEFORE ? 'live-state-before.json' : 'live-state.json'), JSON.stringify({ screens }, null, 2));
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.webp') ? 'webp' : file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function frame(file: string, label: string, width = 520): string {
  return existsSync(file)
    ? `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${width}px;border:1px solid #444"/></div>`
    : `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:720px}
  h1{font-size:14px;margin:0 0 8px}
  h2{font-size:13px;margin:14px 0 0;color:#9cf}
  table{border-collapse:collapse;margin-top:8px} td,th{border:1px solid #444;padding:2px 6px;text-align:left;vertical-align:top;max-width:520px;word-break:break-all} th{color:#9cf}
</style>`;

async function compose(): Promise<void> {
  type Live = { screens: Record<string, { file: string; state: SelState }> };
  const load = (f: string): Live => existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Live : { screens: {} };
  const live = load('live-state.json');
  const before = load('live-state-before.json');
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2720, height: 900 } });
  const table = (src: Live, title: string): string => {
    const names = Object.keys(src.screens);
    if (!names.length) return '';
    const head = `<tr><th>beat</th><th>mouse</th><th>selection (guid / name / 0x1000019f field)</th><th>machine (lit / count)</th><th>first lit material (type / emissive / color / copies)</th><th>overhead label</th></tr>`;
    const rows = names.map((n) => {
      const s = src.screens[n].state;
      return `<tr><td>${n}</td><td>(${s.mouse.x.toFixed(0)},${s.mouse.y.toFixed(0)})</td><td>${s.target ? `0x${s.target.guid.toString(16)} / ${s.target.name} / ${s.target.field ?? '—'}` : '—'}</td><td>${s.machine ? `0x${s.machine.litGuid.toString(16)} / ${s.machine.flipCount}` : '— (no machine)'}</td><td>${s.material ? `${s.material.type} / ${s.material.emissive.toFixed(3)} / ${s.material.color.toFixed(3)} / ${s.material.copies ?? '—'}` : '—'}</td><td>${s.label ? `${s.label.shown ? 'SHOWN' : 'hidden'} "${s.label.text}"` : 'none (no container)'}</td></tr>`;
    }).join('');
    return `<h2>${title}</h2><table>${head}${rows}</table>`;
  };
  const cropCell = (src: Live, name: string, file: string, label: string): string => {
    const s = src.screens[name]?.state;
    if (!s || !existsSync(file)) return `<div class="cell"><div class="lbl">${label}: (no capture)</div></div>`;
    const x = Math.max(0, Math.min(VIEW.width - 300, s.mouse.x - 150));
    const y = Math.max(0, Math.min(VIEW.height - 200, s.mouse.y - 160));
    return `<div class="cell"><div class="lbl">${label}</div><div style="width:600px;height:400px;border:1px solid #444;background-image:url(${dataUrl(file)});background-size:${VIEW.width * 2}px ${VIEW.height * 2}px;background-position:-${x * 2}px -${y * 2}px;image-rendering:pixelated"></div></div>`;
  };
  const beatRow = (title: string, name: string, beforeName = name): string => {
    const cells = [
      cropCell(before, beforeName, join(OUT, `ours-before-${beforeName}.png`), `before — ${beforeName} (2x crop at the click)`),
      cropCell(live, name, join(OUT, `ours-${name}.png`), `after — ${name} (2x crop at the click)`),
      frame(join(OUT, `ours-before-${beforeName}.png`), 'before — whole screen', 560),
      frame(join(OUT, `ours-${name}.png`), 'after — whole screen', 560),
    ];
    return `<h2>${title}</h2><div class="row">${cells.join('')}</div>`;
  };
  const html = `${CSS}<h1>CORE.17.k.b.b.a.g.b — the selected object's overhead name label has no retail counterpart. Retail (UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound @ 004e5ad0 / Global_Loop @ 004e5620 / ApplyLighting @ 004e5320): a click-select SetLightings the object HIGH (luminosity 0.99, diffuse 1.0 — .rdata 0x7bfe80/84) at once, then LOW (0.0 / 0.35 — 0x7bfe78/7c), HIGH, LOW, restore, one SELECTION_FLIP_TIME (0.2 s, 0x7bfe88) apart; its name shows in the toolbar's 0x1000019f field; no text is drawn in the 3D view. Before: an invented overhead name label above the selected object's head, no lighting change.</h1>
    <div class="row">${frame(RETAIL, 'retail reference — reference/images/hud/rawg_06.jpg: a selection ("+Chao Fang-Yi" in the toolbar field with its heart meter) and no overhead text anywhere in the 3D view', 700)}</div>
    ${beatRow('idle — nothing selected', 'idle')}
    ${beatRow('the click — retail: LIGHT_HIGH on the object\'s parts (fullbright texel); before: the overhead label, materials untouched', 'select-high')}
    ${beatRow('the first flip (0.2 s) — retail: LIGHT_LOW (diffuse 0.35, the object dims); before: the label stays', 'select-low')}
    ${beatRow('after the fourth flip (0.8 s) — retail: the object\'s own materials back, the selection stays in the toolbar field; before: the label stays as long as the selection', 'select-restored')}
    ${table(live, 'the selection state per beat (after, live-state.json)')}
    ${table(before, 'the selection state per beat (before, live-state-before.json)')}`;
  await page.setContent(html);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'core17kbbagb-selection-lighting-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17kbbagb] wrote ${join(OUT, 'core17kbbagb-selection-lighting-sidebyside.png')}`);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--compose-only')) await captureLive();
  if (!BEFORE) await compose();
}

main().catch((e) => { console.error(e); process.exit(1); });
