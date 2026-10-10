/**
 * CORE.17.q.a — side-by-side evidence: world lighting evaluated per VERTEX
 * (D3D fixed-function Gouraud) with the hard Range cutoff and calc_point_light's
 * static burn-in on env cells, vs the per-fragment r160 Lambert it replaces.
 *
 * Composes (no browser driving — the frames come from
 * `npx tsx tools/capture-ui-screens.ts --scenes world-dungeon-stone
 * world-dungeon-stone-night world-dungeon world-town-day` copied to
 * verification/core17qa/after-*.png, the CORE.17.q.d frames as the BEFORE of
 * the dungeon-stone scenes (verification/core17qd/after-*.png — same code
 * otherwise, captured the same morning), the CORE.17.r harness frame as the
 * BEFORE of world-town-day, and `npx tsx tools/probe-core17qa-gouraud-lighting.ts`
 * → verification/core17qa/after-*.png + after-probe-samples.json):
 *
 *   core17qa-gouraud-sidebyside.png
 *     row 1: retail rawg_04 | retail rawg_09
 *     row 2: world-dungeon-stone — BEFORE (per fragment) | AFTER (per vertex)
 *     row 3: world-dungeon-stone-night — BEFORE | AFTER; world-dungeon (cave) AFTER
 *     row 4: world-town-day — BEFORE | AFTER (landscape + objects: the sun term per vertex)
 *     row 5: the probe — as-is | torches only | torches off, with region means + luminance histograms
 *
 * Usage: npx tsx tools/capture-core17qa-gouraud-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17qa');
const QD = join(REPO, 'verification', 'core17qd');
const REFS = join(REPO, 'reference', 'images', 'hud');

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function cell(file: string, label: string, w = 760): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}</div><div class="missing" style="width:${w}px">missing: ${file.replace(REPO + '/', '')}</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><img style="width:${w}px" src="${dataUrl(file)}"/></div>`;
}

async function main(): Promise<void> {
  const samplesFile = join(OUT, 'after-probe-samples.json');
  const samples = existsSync(samplesFile) ? JSON.parse(readFileSync(samplesFile, 'utf8')) : null;
  const before = existsSync(join(QD, 'probe-samples.json')) ? JSON.parse(readFileSync(join(QD, 'probe-samples.json'), 'utf8')) : null;
  const fmt = (k: string) => samples?.results?.[k]
    ? Object.entries(samples.results[k] as Record<string, { mean: number[]; hist: number[] }>).filter(([r]) => r !== 'world').map(([r, v]) => `${r} (${v.mean.join(',')})`).join(' · ')
      + ` — world luminance bins 0–5 (×16): ${(samples.results[k].world.hist as number[]).slice(0, 6).join(' / ')}`
    : '';
  const bfmt = (k: string) => before?.results?.[k] ? 'BEFORE ' + Object.entries(before.results[k] as Record<string, number[]>).map(([r, v]) => `${r} (${v.join(',')})`).join(' · ') : '';
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 } });
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
  await page.setContent(`${css}<h1>CORE.17.q.a — world lighting per VERTEX (D3D fixed-function Gouraud): hard Range cutoff, calc_point_light's static burn-in on env cells, the sun term per vertex on landscape and objects</h1>
    <div class="note">Retail (decompiled EoL client): objects take up to 8 D3D hardware lights (config_hardware_light @ 0059ad30 — Diffuse = colour × intensity, Range = falloff × 1.5, attenuation 1/d, nothing beyond Range); env cells burn every pooled static light into their vertex diffuse through calc_point_light @ 0059c8b0 (range = falloff × 1.3, wrapped N·L (cos θ + 0.5) / 1.5, (1 − d/range) × intensity / d², per-channel min with the colour) and take the dynamic lights (viewer light) through the hardware path; the texture stage is a plain MODULATE (no headroom above the texel). BEFORE = three.js per-fragment Lambert under the same equation: every fragment inside a torch's range clamped to 1, whole cells at raw texel brightness, round per-pixel pools. Ours: 1568x775 SwiftShader captures over the ACE stack (weather off, day group Sunny, time pinned), dungeon at the portal's own Destination 0x01F60289 yaw 1.6, town at @telepoi holtburg yaw 0.</div>
    <div class="row">
      ${cell(join(REFS, 'rawg_04.jpg'), 'retail rawg_04 — the tan cobble dungeon set: warm pools that fade ACROSS polygons (vertex gradients), beams')}
      ${cell(join(REFS, 'rawg_09.jpg'), 'retail rawg_09 — the same set, wall torch + beams, the wall brightest at the vertices nearest the sconce')}
    </div>
    <div class="row">
      ${cell(join(QD, 'after-world-dungeon-stone.png'), 'BEFORE (per fragment, CORE.17.q.d frame) — world-dungeon-stone (noon): a round saturated pool on the far wall, the floor at texel brightness')}
      ${cell(join(OUT, 'after-world-dungeon-stone.png'), 'AFTER (per vertex) — world-dungeon-stone (noon): the pools sit on the vertices nearest each sconce and fade linearly across the polygons; big hall polygons whose corners lie beyond 1.3 × falloff take ambient 0.2 + the viewer light\'s per-vertex term')}
    </div>
    <div class="row">
      ${cell(join(QD, 'after-world-dungeon-stone-night.png'), 'BEFORE — world-dungeon-stone-night (midnight)', 560)}
      ${cell(join(OUT, 'after-world-dungeon-stone-night.png'), 'AFTER — world-dungeon-stone-night (midnight): identical to noon (the sealed ambient is constant)', 560)}
      ${cell(join(OUT, 'after-world-dungeon.png'), 'AFTER — world-dungeon (the Training Academy cave 0x86020115): the same per-vertex path', 560)}
    </div>
    <div class="row">
      ${cell(join(REPO, 'verification', 'core17r', 'harness', 'run4-world-town-day.png'), 'BEFORE (per fragment, CORE.17.r harness frame) — world-town-day (Holtburg noon, Sunny)')}
      ${cell(join(OUT, 'after-world-town-day.png'), 'AFTER (per vertex) — world-town-day: landscape (sun + ambient per vertex, as CLandBlockStruct::calc_lighting) and objects (the sun as one hardware light per vertex)')}
    </div>
    <h1>the probe (tools/probe-core17qa-gouraud-lighting.ts, yaw 0 at the drop point)</h1>
    <div class="row">
      ${cell(join(OUT, 'after-dungeon-yaw0.png'), 'as-is (noon): ' + fmt('dungeon_noon') + '<br>' + bfmt('noon_asis'), 560)}
      ${cell(join(OUT, 'after-dungeon-torches-only.png'), 'DAT torches only (sky ambient hidden, viewer light 0): ' + fmt('dungeon_torchesOnly') + '<br>' + bfmt('noon_dungeonAmbientHidden_viewer0'), 560)}
      ${cell(join(OUT, 'after-dungeon-torches-off.png'), 'DAT torches off (ambient + viewer light only): ' + fmt('dungeon_torchesOff') + '<br>' + bfmt('noon_datLightsOff_only'), 560)}
      ${cell(join(OUT, 'after-dungeon-yaw1.png'), 'as-is, yaw 1.6 (the scene framing)', 560)}
    </div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17qa-gouraud-sidebyside.png'), fullPage: true });
  console.log(`[core17qa] wrote ${join(OUT, 'core17qa-gouraud-sidebyside.png')}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
