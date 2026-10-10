/**
 * CORE.17.h.g.d — side-by-side evidence for the options text cells laid out
 * per UIElement_Text (UIElementTextLayout.ts): the row labels in the DAT
 * label font 0x40000002 (14px, not the 16px UI font), captions in the
 * caption font 0x40000025 (11px), headers in 0x40000000, DAT p27 colours;
 * "Environment Texture Detail" (134 px > the 130 px cell) wraps and shows
 * its first line "Environment Texture" flush right with "Detail" clipped
 * below the 14px cell — the way retail's CalcJustification (avail =
 * max(box, content)) + the DrawHere clip render it — instead of the whole
 * string spilling past the cell's left edge and out of the list.
 *
 * Composes (no browser driving — the live captures come from a FRESH
 * profile via `npx tsx tools/capture-ui-screens.ts --scenes
 * hud-options-config hud-options-config-scrolled`):
 *
 *   core17hgd-options-sidebyside.png
 *     row 1: retail Config tab (options-config.jpg, 300x520) (2x) | ours,
 *            list at top (2x) | ours, list scrolled to its end (2x)
 *     row 2: 3x details — retail Sound rows (label font vs header font,
 *            caption size) | ours same rows | ours Rendering Quality rows
 *            (the wrapped label)
 *
 *   core17hgd-fullscreen-sidebyside.png
 *     retail panel | ours whole screen top | ours whole screen scrolled.
 *
 * Crop boxes (ours: 1568x775 scene capture, options panel docked right):
 *   panel: x 1268, y 140, 300 wide (tab strip at the top of the crop)
 *
 * Usage: npx tsx tools/capture-core17hgd-options-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgd');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const RETAIL_CONFIG = join(REPO, 'reference/images/hud/options-config.jpg');
const OURS_TOP = join(SCENES, 'hud-options-config.png');
const OURS_END = join(SCENES, 'hud-options-config-scrolled.png');
const PANEL_X = 1268;
const PANEL_Y = 140;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number; zoom: number }

const CONFIG_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail EoL Config tab (options-config.jpg): row labels in the 14px label font 0x40000002 (white), headers in the 16px UI font 0x40000000 (0xffef00), slider captions in the 11px caption font 0x40000025', x: 0, y: 0, w: 300, h: 520, zoom: 2 },
  { file: OURS_TOP, label: 'ours Config tab, FRESH profile, list at its top — same crop (300x520); labels / captions / headers now in their DAT fonts and p27 colours', x: PANEL_X, y: PANEL_Y, w: 300, h: 520, zoom: 2 },
  { file: OURS_END, label: 'ours, list scrolled to its end — "Environment Texture Detail" (134px in 0x40000002, cell 130) wraps per UIElement_Text: "Environment Texture" flush right, "Detail" on a second line clipped below the 14px cell', x: PANEL_X, y: PANEL_Y, w: 300, h: 520, zoom: 2 },
];
const DETAIL_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail — Sound Options rows at 3x: header (UI font, yellow) vs "Sound Features" label (smaller label font)', x: 0, y: 40, w: 300, h: 90, zoom: 3 },
  { file: OURS_TOP, label: 'ours — same rows at 3x', x: PANEL_X, y: PANEL_Y + 40, w: 300, h: 90, zoom: 3 },
  { file: RETAIL_CONFIG, label: 'retail — Camera rows at 3x: "Camera Adjustment Speed" (129px) ends flush at the column; "Slow"/"Fast" captions smaller than the labels', x: 0, y: 180, w: 300, h: 110, zoom: 3 },
  { file: OURS_TOP, label: 'ours — same rows at 3x', x: PANEL_X, y: PANEL_Y + 180, w: 300, h: 110, zoom: 3 },
  { file: OURS_END, label: 'ours — Rendering Quality rows at 3x: the wrapped "Environment Texture" label, first glyph intact, flush right like its neighbours (retail draws the same first line; "Detail" is clipped)', x: PANEL_X, y: PANEL_Y + 160, w: 300, h: 120, zoom: 3 },
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
  console.log(`[core17hgd] wrote ${out}`);
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
    join(OUT, 'core17hgd-options-sidebyside.png'), 1900,
  );
  await shoot(`<div class="row">
    ${fullCell(RETAIL_CONFIG, 'retail EoL Config tab (panel-only reference, 300x520)', 300)}
    ${fullCell(OURS_TOP, 'ours — Config tab over the world, fresh profile, list at top (whole screen)', 780)}
    ${fullCell(OURS_END, 'ours — Config tab scrolled to its end (whole screen)', 780)}
  </div>`, join(OUT, 'core17hgd-fullscreen-sidebyside.png'), 1900);
}

main().catch((e) => { console.error(e); process.exit(1); });
