/**
 * CORE.17.h.e — side-by-side evidence for the Config tab's retail strings
 * (table 0x23000003 by retail token: "Align camera to slope", "Sync with
 * Refresh Rate", Sound/Camera/Graphics rows, slider end captions, Sound
 * Features choices).
 *
 * Composes (no browser driving — the live capture comes from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-options-config`):
 *
 *   core17he-options-sidebyside.png
 *     row 1: retail Config tab (reference/images/hud/options-config.jpg,
 *            300x520) (2x) | ours Config tab, same 300x520 crop (2x)
 *     row 2: the two rows whose wording changed, 3x: "Align camera to
 *            slope" (Camera) and "Full Screen / Sync with Refresh Rate"
 *            (Graphics) — retail | ours
 *
 *   core17he-fullscreen-sidebyside.png
 *     retail panel | ours whole screen (Config over the world) — the
 *     whole-screen frame the WHOLE-SCREEN RULE asks for.
 *
 * Crop boxes (ours: 1568x775 scene capture, options panel docked right):
 *   panel: x 1268, y 140, 300 wide (tab strip at the top of the crop)
 *
 * Usage: npx tsx tools/capture-core17he-options-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17he');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const RETAIL_CONFIG = join(REPO, 'reference/images/hud/options-config.jpg');
const OURS_CONFIG = join(SCENES, 'hud-options-config.png');
const PANEL_X = 1268;
const PANEL_Y = 140;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number; zoom: number }

const CONFIG_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail EoL Config tab (options-config.jpg) — labels from 0x23000003: "Align camera to slope", "Sync with Refresh Rate", Soft/Hard … Speed/Detail captions, Stereo choice', x: 0, y: 0, w: 300, h: 520, zoom: 2 },
  { file: OURS_CONFIG, label: 'ours Config tab — same crop (300x520): every header / label / caption / choice resolved through OptionsStrings.configString = 0x23000003[acStringHash("ID_…")]', x: PANEL_X, y: PANEL_Y, w: 300, h: 520, zoom: 2 },
];
// The rows whose wording changed: retail panel y ≈ 285-305 (Align camera to
// slope) and y ≈ 355-395 (Full Screen / Sync with Refresh Rate).
const DETAIL_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail — "Align camera to slope" (sentence case)', x: 0, y: 282, w: 300, h: 26, zoom: 3 },
  { file: OURS_CONFIG, label: 'ours — was "Align Camera To Slope"', x: PANEL_X, y: PANEL_Y + 282, w: 300, h: 26, zoom: 3 },
  { file: RETAIL_CONFIG, label: 'retail — "Full Screen" / "Sync with Refresh Rate"', x: 0, y: 352, w: 300, h: 46, zoom: 3 },
  { file: OURS_CONFIG, label: 'ours — was "Sync With Refresh Rate"', x: PANEL_X, y: PANEL_Y + 352, w: 300, h: 46, zoom: 3 },
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
  console.log(`[core17he] wrote ${out}`);
}

async function main(): Promise<void> {
  for (const f of [RETAIL_CONFIG, OURS_CONFIG]) {
    if (!existsSync(f)) throw new Error(`missing input: ${f}`);
  }
  mkdirSync(OUT, { recursive: true });
  copyFileSync(OURS_CONFIG, join(OUT, 'hud-options-config.png'));
  await shoot(
    `<div class="row">${CONFIG_ROW.map(cropCell).join('')}</div><div class="row">${DETAIL_ROW.map(cropCell).join('')}</div>`,
    join(OUT, 'core17he-options-sidebyside.png'), 1900,
  );
  await shoot(`<div class="row">
    ${fullCell(RETAIL_CONFIG, 'retail EoL Config tab (panel-only reference, 300x520)', 300)}
    ${fullCell(OURS_CONFIG, 'ours — Config tab over the world (whole screen, capture-ui-screens.ts --scenes hud-options-config)', 1100)}
  </div>`, join(OUT, 'core17he-fullscreen-sidebyside.png'), 1450);
}

main().catch((e) => { console.error(e); process.exit(1); });
