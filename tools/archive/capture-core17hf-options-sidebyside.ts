/**
 * CORE.17.h.f — side-by-side evidence for the Config tab's retail DEFAULTS
 * + slider RANGES (gmConfigUI::InitOptions SetDefaultValue values in the
 * UIPreferences::SetPreferenceRange ranges): Play Sounds Only When Active +
 * Align camera to slope ON, Sync with Refresh Rate OFF, Camera Stiffness
 * 0.45 of 0.2857..1.0 (thumb ≈23%), Adjustment Speed 40 of 5..80 (≈47%),
 * Field of View 90 of 10..160 (≈53%).
 *
 * Composes (no browser driving — the live capture comes from a FRESH
 * profile via `npx tsx tools/capture-ui-screens.ts --scenes
 * hud-options-config`, so it shows the first-session defaults):
 *
 *   core17hf-options-sidebyside.png
 *     row 1: retail Config tab (reference/images/hud/options-config.jpg,
 *            300x520) (2x) | ours Config tab, same 300x520 crop (2x)
 *     row 2: the rows whose DEFAULT changed, 3x — Play Sounds Only When
 *            Active / the camera slider trio / Align camera to slope /
 *            Full Screen + Sync with Refresh Rate — retail | ours
 *
 *   core17hf-fullscreen-sidebyside.png
 *     retail panel | ours whole screen (Config over the world) — the
 *     whole-screen frame the WHOLE-SCREEN RULE asks for.
 *
 * Crop boxes (ours: 1568x775 scene capture, options panel docked right):
 *   panel: x 1268, y 140, 300 wide (tab strip at the top of the crop)
 *
 * Usage: npx tsx tools/capture-core17hf-options-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hf');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const RETAIL_CONFIG = join(REPO, 'reference/images/hud/options-config.jpg');
const OURS_CONFIG = join(SCENES, 'hud-options-config.png');
const PANEL_X = 1268;
const PANEL_Y = 140;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number; zoom: number }

const CONFIG_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail EoL Config tab (options-config.jpg): Play Sounds Only When Active + Align camera to slope ON, Sync with Refresh Rate OFF; Stiffness thumb ≈23%, Adjustment Speed ≈47%, Field of View ≈53%', x: 0, y: 0, w: 300, h: 520, zoom: 2 },
  { file: OURS_CONFIG, label: 'ours Config tab, FRESH profile (first-session OPTIONS_DEFAULTS) — same crop (300x520): every toggle + slider at its gmConfigUI::InitOptions SetDefaultValue in its SetPreferenceRange', x: PANEL_X, y: PANEL_Y, w: 300, h: 520, zoom: 2 },
];
const DETAIL_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail — "Play Sounds Only When Active" ON', x: 0, y: 120, w: 300, h: 30, zoom: 3 },
  { file: OURS_CONFIG, label: 'ours — was OFF', x: PANEL_X, y: PANEL_Y + 120, w: 300, h: 30, zoom: 3 },
  { file: RETAIL_CONFIG, label: 'retail — Stiffness 0.45 of 0.2857..1.0 / Speed 40 of 5..80 / FOV 90 of 10..160', x: 0, y: 175, w: 300, h: 105, zoom: 3 },
  { file: OURS_CONFIG, label: 'ours — was 50% / 50% / 75% (90 of 60..100)', x: PANEL_X, y: PANEL_Y + 175, w: 300, h: 105, zoom: 3 },
  { file: RETAIL_CONFIG, label: 'retail — "Align camera to slope" ON', x: 0, y: 282, w: 300, h: 26, zoom: 3 },
  { file: OURS_CONFIG, label: 'ours — was OFF', x: PANEL_X, y: PANEL_Y + 282, w: 300, h: 26, zoom: 3 },
  { file: RETAIL_CONFIG, label: 'retail — "Full Screen" OFF (windowed capture) / "Sync with Refresh Rate" OFF', x: 0, y: 352, w: 300, h: 46, zoom: 3 },
  { file: OURS_CONFIG, label: 'ours — Sync was ON; Full Screen stays browser-gated OFF', x: PANEL_X, y: PANEL_Y + 352, w: 300, h: 46, zoom: 3 },
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
  console.log(`[core17hf] wrote ${out}`);
}

async function main(): Promise<void> {
  for (const f of [RETAIL_CONFIG, OURS_CONFIG]) {
    if (!existsSync(f)) throw new Error(`missing input: ${f}`);
  }
  mkdirSync(OUT, { recursive: true });
  copyFileSync(OURS_CONFIG, join(OUT, 'hud-options-config.png'));
  await shoot(
    `<div class="row">${CONFIG_ROW.map(cropCell).join('')}</div><div class="row">${DETAIL_ROW.map(cropCell).join('')}</div>`,
    join(OUT, 'core17hf-options-sidebyside.png'), 1900,
  );
  await shoot(`<div class="row">
    ${fullCell(RETAIL_CONFIG, 'retail EoL Config tab (panel-only reference, 300x520)', 300)}
    ${fullCell(OURS_CONFIG, 'ours — Config tab over the world, fresh-profile defaults (whole screen, capture-ui-screens.ts --scenes hud-options-config)', 1100)}
  </div>`, join(OUT, 'core17hf-fullscreen-sidebyside.png'), 1450);
}

main().catch((e) => { console.error(e); process.exit(1); });
