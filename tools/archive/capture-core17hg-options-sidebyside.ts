/**
 * CORE.17.h.g — side-by-side evidence for the Config tab's rows BELOW
 * Adaptive Degrade Bias (Degrade Distance + the Rendering Quality / Input /
 * UI sections, gmConfigUI::InitOptions decomp :158684-158729) and the
 * scrolling list whose scrollbar thumb spans only part of its track.
 *
 * Composes (no browser driving — the live captures come from a FRESH
 * profile via `npx tsx tools/capture-ui-screens.ts --scenes
 * hud-options-config hud-options-config-scrolled`):
 *
 *   core17hg-options-sidebyside.png
 *     row 1: retail Config tab (reference/images/hud/options-config.jpg,
 *            300x520) (2x) | ours Config tab, list at its top, same crop
 *            (2x) | ours, list scrolled to its end (2x)
 *     row 2: the scrollbar columns at 3x — retail thumb (y 47..279 of the
 *            42..474 track ≈ 54%) | ours at the top | ours at the end
 *
 *   core17hg-fullscreen-sidebyside.png
 *     retail panel | ours whole screen top | ours whole screen scrolled —
 *     the WHOLE-SCREEN frames the WHOLE-SCREEN RULE asks for.
 *
 * Crop boxes (ours: 1568x775 scene capture, options panel docked right):
 *   panel: x 1268, y 140, 300 wide (tab strip at the top of the crop)
 *
 * Usage: npx tsx tools/capture-core17hg-options-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hg');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const RETAIL_CONFIG = join(REPO, 'reference/images/hud/options-config.jpg');
const OURS_TOP = join(SCENES, 'hud-options-config.png');
const OURS_END = join(SCENES, 'hud-options-config-scrolled.png');
const PANEL_X = 1268;
const PANEL_Y = 140;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number; zoom: number }

const CONFIG_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail EoL Config tab (options-config.jpg): list at its top — the scrollbar thumb covers only ~54% of the track because Degrade Distance + three more sections follow below', x: 0, y: 0, w: 300, h: 520, zoom: 2 },
  { file: OURS_TOP, label: 'ours Config tab, FRESH profile, list at its top — same crop (300x520); thumb now part-height', x: PANEL_X, y: PANEL_Y, w: 300, h: 520, zoom: 2 },
  { file: OURS_END, label: 'ours, list scrolled to its end — Degrade Distance (Close/Far, 50), Rendering Quality Options (Landscape/Environment Texture Detail, Texture Filtering, Landscape Draw Distance menus + Environment Detail Textures ON, Multiple Pass Alpha OFF), Input Options (bare Mouselook Sensitivity slider 0.55, Invert mouselook axes, Turn your character…), UI Options (Chat Font Face Palatino Linotype, Chat Font Size Small), closing rule', x: PANEL_X, y: PANEL_Y, w: 300, h: 520, zoom: 2 },
];
const DETAIL_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail — scrollbar column (thumb y 47..279 of 42..474)', x: 270, y: 20, w: 30, h: 480, zoom: 2 },
  { file: OURS_TOP, label: 'ours — scrollbar column, list at top', x: PANEL_X + 270, y: PANEL_Y + 20, w: 30, h: 480, zoom: 2 },
  { file: OURS_END, label: 'ours — scrollbar column, list at end', x: PANEL_X + 270, y: PANEL_Y + 20, w: 30, h: 480, zoom: 2 },
  { file: OURS_END, label: 'ours — the new sections at 3x (Rendering Quality / Input / UI)', x: PANEL_X, y: PANEL_Y + 150, w: 300, h: 330, zoom: 3 },
];

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

function cropCell(p: Panel): string {
  return `<div class="cell"><div class="lbl">${p.label}</div>
    <div class="clip" style="width:${p.w * p.zoom}px;height:${p.h * p.zoom}px">
      <img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * p.zoom}px;top:${-p.y * p.zoom}px;transform-origin:0 0;transform:scale(${p.zoom});image-rendering:pixelated"/>
    </div></div>`;
}

function fullCell(file: string, label: string, w: number): string {
  return `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${w}px;display:block"/></div>`;
}

const STYLE = `<style>
  body{margin:0;background:#111;color:#ddd;font:12px/1.3 system-ui,sans-serif}
  .row{display:flex;gap:12px;padding:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{max-width:600px;color:#ccc}
  .clip{position:relative;overflow:hidden;background:#000}
</style>`;

async function shoot(html: string, out: string, width: number): Promise<void> {
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.setContent(STYLE + html);
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(`[core17hg] wrote ${out}`);
}

async function main(): Promise<void> {
  for (const f of [RETAIL_CONFIG, OURS_TOP, OURS_END]) {
    if (!existsSync(f)) throw new Error(`missing input: ${f}`);
  }
  mkdirSync(OUT, { recursive: true });
  copyFileSync(OURS_TOP, join(OUT, 'hud-options-config.png'));
  copyFileSync(OURS_END, join(OUT, 'hud-options-config-scrolled.png'));
  await shoot(
    `<div class="row">${CONFIG_ROW.map(cropCell).join('')}</div><div class="row">${DETAIL_ROW.map(cropCell).join('')}</div>`,
    join(OUT, 'core17hg-options-sidebyside.png'), 1900,
  );
  await shoot(`<div class="row">
    ${fullCell(RETAIL_CONFIG, 'retail EoL Config tab (panel-only reference, 300x520)', 300)}
    ${fullCell(OURS_TOP, 'ours — Config tab over the world, fresh profile, list at top (whole screen)', 780)}
    ${fullCell(OURS_END, 'ours — Config tab scrolled to its end (whole screen)', 780)}
  </div>`, join(OUT, 'core17hg-fullscreen-sidebyside.png'), 1900);
}

main().catch((e) => { console.error(e); process.exit(1); });
