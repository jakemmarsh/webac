/**
 * CORE.17.q.d — side-by-side evidence: the sealed-dungeon ambient is the
 * constant DUNGEON_LIGHT_MINIMUM (white 0.2), so the Holtburg Dungeon reads
 * the same at noon and at midnight.
 *
 * Composes (no browser driving — the frames come from
 * `npx tsx tools/capture-ui-screens.ts --scenes world-dungeon-stone
 * world-dungeon-stone-night` copied to verification/core17qd/after-*.png,
 * the CORE.17.q.c before-frames in verification/core17qc/after-*.png, and
 * `npx tsx tools/probe-core17qd-dungeon-ambient.ts` → verification/core17qd/):
 *
 *   core17qd-dungeon-sidebyside.png
 *     row 1: retail rawg_04 | retail rawg_09
 *     row 2: BEFORE (CORE.17.q.c frames) — noon | midnight (the sky ambient reached in)
 *     row 3: AFTER — noon | midnight | the per-pixel diff of the two AFTER frames
 *     row 4: the probe — noon | midnight | dungeon ambient hidden | DAT torches off
 *
 * Usage: npx tsx tools/capture-core17qd-dungeon-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17qd');
const BEFORE = join(REPO, 'verification', 'core17qc');
const REFS = join(REPO, 'reference', 'images', 'hud');
const AFTER_DAY = join(OUT, 'after-world-dungeon-stone.png');
const AFTER_NIGHT = join(OUT, 'after-world-dungeon-stone-night.png');
const BEFORE_DAY = join(BEFORE, 'after-world-dungeon-stone.png');
const BEFORE_NIGHT = join(BEFORE, 'after-world-dungeon-stone-night.png');

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function cell(file: string, label: string, w = 760): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}</div><div class="missing" style="width:${w}px">missing: ${file.replace(REPO + '/', '')}</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><img style="width:${w}px" src="${dataUrl(file)}"/></div>`;
}

async function main(): Promise<void> {
  for (const f of [AFTER_DAY, AFTER_NIGHT]) if (!existsSync(f)) throw new Error(`missing ${f} — run capture-ui-screens.ts --scenes world-dungeon-stone world-dungeon-stone-night and copy the frames first`);
  const samplesFile = join(OUT, 'probe-samples.json');
  const samples = existsSync(samplesFile) ? JSON.parse(readFileSync(samplesFile, 'utf8')) : null;
  const fmt = (k: string) => samples?.results?.[k] ? Object.entries(samples.results[k] as Record<string, number[]>).map(([r, v]) => `${r} (${v.join(',')})`).join(' · ') : '';
  const state = (k: string) => samples?.states?.[k] ? ` — live sky: ambient ${JSON.stringify(samples.states[k].ambient)}, fog ${JSON.stringify(samples.states[k].fog)}` : '';
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 } });

  // Per-pixel diff of the two AFTER frames (the world viewport only — the
  // HUD clock / chat timestamps differ by construction).
  // (anonymous callbacks only — tsx's esbuild keepNames would inject a
  // `__name` helper for a named function constant, which the page lacks)
  const diff = await page.evaluate(async ([a, b]) => {
    const [ia, ib] = await Promise.all([a, b].map((src) => new Promise<HTMLImageElement>((r) => { const im = new Image(); im.onload = () => r(im); im.src = src; })));
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const [da, db] = [ia, ib].map((im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d')!; x.drawImage(im, 0, 0); return x.getImageData(0, 0, w, h).data; });
    const out = document.createElement('canvas'); out.width = w; out.height = h; const ox = out.getContext('2d')!; const od = ox.createImageData(w, h);
    let differing = 0, worldDiffering = 0, worldPixels = 0;
    const worldBottom = Math.floor(h * 0.72); // above the HUD band
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      const y = Math.floor(i / 4 / w);
      const inWorld = y < worldBottom;
      if (inWorld) worldPixels++;
      if (d > 0) { differing++; if (inWorld) worldDiffering++; }
      od.data[i] = d > 0 ? 255 : da[i] >> 2; od.data[i + 1] = da[i + 1] >> 2; od.data[i + 2] = da[i + 2] >> 2; od.data[i + 3] = 255;
    }
    ox.putImageData(od, 0, 0);
    return { w, h, differing, total: w * h, worldDiffering, worldPixels, png: out.toDataURL('image/png') };
  }, [dataUrl(AFTER_DAY), dataUrl(AFTER_NIGHT)]);
  const diffFile = join(OUT, 'after-noon-vs-night-diff.png');
  writeFileSync(diffFile, Buffer.from(diff.png.split(',')[1], 'base64'));
  const diffSummary = { differingPixels: diff.differing, totalPixels: diff.total, differingPct: +(100 * diff.differing / diff.total).toFixed(3), worldDifferingPixels: diff.worldDiffering, worldPixels: diff.worldPixels, worldDifferingPct: +(100 * diff.worldDiffering / diff.worldPixels).toFixed(3) };
  writeFileSync(join(OUT, 'after-noon-vs-night-diff.json'), JSON.stringify(diffSummary, null, 2));
  console.log('[core17qd] noon vs night diff:', JSON.stringify(diffSummary));

  const css = `<style>
    body{background:#111;color:#ddd;font:14px sans-serif;margin:12px}
    h1{font-size:16px;margin:0 0 8px}
    .row{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{font-size:13px;color:#ccc;max-width:760px}
    img{border:1px solid #444;display:block}
    .missing{height:120px;border:1px dashed #666;color:#888;padding:8px}
    .note{font-size:12px;color:#aaa;max-width:2300px;margin-bottom:10px}
  </style>`;
  await page.setContent(`${css}<h1>CORE.17.q.d — the sealed-dungeon ambient is the constant DUNGEON_LIGHT_MINIMUM (white 0.2): the Holtburg Dungeon reads the same at noon and at midnight</h1>
    <div class="note">Retail: CellManager::ChangePosition @ 004559b0 releases the landscape (LScape::release_all, loaded_cell_id = 0) and calls SmartBox::SetWorldAmbientLight(DUNGEON_LIGHT_MINIMUM, 0xffffffff) on entering a sealed cell; LScape::UseTime @ 00505880 (the only light-tick / fog-state caller) is gated by loaded_cell_id != 0, so the sun / ambient / fog freeze at the entry tick. Ours: 1568x775 SwiftShader captures over the ACE stack (weather off, day group Sunny, time pinned after the teleport), the portal's own Destination 0x01F60289, yaw 1.6.</div>
    <div class="row">
      ${cell(join(REFS, 'rawg_04.jpg'), 'retail rawg_04 — the tan cobble dungeon set, torch pools on the wall, beams')}
      ${cell(join(REFS, 'rawg_09.jpg'), 'retail rawg_09 — the same set, wall torch + beams')}
    </div>
    <div class="row">
      ${cell(BEFORE_DAY, 'BEFORE (CORE.17.q.c frame) — noon: the sky\'s 0.35 e6e6ff ambient × the 1.44 object factor lit the cells')}
      ${cell(BEFORE_NIGHT, 'BEFORE — midnight: the sky\'s 0.40 c864ff ambient — a magenta cast retail never had')}
    </div>
    <div class="row">
      ${cell(AFTER_DAY, 'AFTER — world-dungeon-stone (noon): white 0.2 ambient + DAT torches + viewer light')}
      ${cell(AFTER_NIGHT, 'AFTER — world-dungeon-stone-night (midnight): identical world')}
      ${cell(diffFile, `AFTER noon vs midnight per-pixel diff (red = any channel differs): ${diffSummary.worldDifferingPixels} of ${diffSummary.worldPixels} world pixels (${diffSummary.worldDifferingPct}%) above the HUD band; ${diffSummary.differingPixels} of ${diffSummary.totalPixels} (${diffSummary.differingPct}%) whole frame — the HUD clock / chat timestamps differ by construction`)}
    </div>
    <h1>the probe (tools/probe-core17qd-dungeon-ambient.ts, yaw 0 at the drop point)</h1>
    <div class="row">
      ${cell(join(OUT, 'probe-noon.png'), 'noon as-is: ' + fmt('noon_asis') + state('noon_asis'), 560)}
      ${cell(join(OUT, 'probe-night.png'), 'midnight: ' + fmt('night') + state('night'), 560)}
      ${cell(join(OUT, 'probe-noambient-noviewer.png'), 'dungeon ambient hidden + viewer light 0: ' + fmt('noon_dungeonAmbientHidden_viewer0'), 560)}
      ${cell(join(OUT, 'probe-nolights.png'), 'DAT torches off (ambient + viewer light only): ' + fmt('noon_datLightsOff_only'), 560)}
    </div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17qd-dungeon-sidebyside.png'), fullPage: true });
  console.log(`[core17qd] wrote ${join(OUT, 'core17qd-dungeon-sidebyside.png')}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
