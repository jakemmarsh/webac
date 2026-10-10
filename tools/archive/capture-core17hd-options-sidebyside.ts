/**
 * CORE.17.h.d — side-by-side evidence for the options-tab option widgets'
 * own DAT art + list-template geometry (UIOption_Slider gradient track +
 * 7px widget, right-justified label column, menu plate + arrow, separator-
 * before-header).
 *
 * Composes (no browser driving — the live captures come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-options-chat
 * hud-options-chat-active-lowered hud-options-config`):
 *
 *   core17hd-options-sidebyside.png
 *     row 1: retail Chat tab (reference/images/hud/chat-options.jpg, panel-
 *            only capture, 300x525) "General Chat Options" crop (2x)
 *            | ours, fresh character (2x) | ours, Active dragged to 30% (2x)
 *     row 2: retail Config tab (options-config.jpg, 300x520) (2x)
 *            | ours Config tab, same 300x520 crop (2x)
 *
 *   core17hd-fullscreen-sidebyside.png
 *     retail panels | ours whole screens (Chat / Config over the world) — the
 *     whole-screen frames the WHOLE-SCREEN RULE asks for.
 *
 * Crop boxes (ours: 1568x775 scene capture, options panel docked right):
 *   panel: x 1268, y 140, 300 wide (tab strip at the top of the crop)
 *
 * Usage: npx tsx tools/capture-core17hd-options-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hd');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const RETAIL_CHAT = join(REPO, 'reference/images/hud/chat-options.jpg');
const RETAIL_CONFIG = join(REPO, 'reference/images/hud/options-config.jpg');
const OURS_CHAT = join(SCENES, 'hud-options-chat.png');
const OURS_CHAT_LOWERED = join(SCENES, 'hud-options-chat-active-lowered.png');
const OURS_CONFIG = join(SCENES, 'hud-options-config.png');
const ZOOM = 2;
const PANEL_X = 1268;
const PANEL_Y = 140;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

const CHAT_ROW: Panel[] = [
  { file: RETAIL_CHAT, label: 'retail EoL Chat tab (chat-options.jpg) — gradient track 0x06001285, 7px widget, labels end at x 138, no rule under the first header', x: 0, y: 0, w: 300, h: 110 },
  { file: OURS_CHAT, label: 'ours, fresh character — UIOption_Slider art from the 0x2100002b template base chain (0x2100003e:0x1000036e), Inactive at the DAT default 0.5', x: PANEL_X, y: PANEL_Y, w: 300, h: 110 },
  { file: OURS_CHAT_LOWERED, label: 'ours, Active dragged to ~30% — linked Inactive follows; the gradient stays full-width (no fill bar, as retail)', x: PANEL_X, y: PANEL_Y, w: 300, h: 110 },
];
const CONFIG_ROW: Panel[] = [
  { file: RETAIL_CONFIG, label: 'retail EoL Config tab (options-config.jpg) — every list template: menu plate + arrow, checkbox+slider, sliders with captions, separator BEFORE each later header', x: 0, y: 0, w: 300, h: 520 },
  { file: OURS_CONFIG, label: 'ours Config tab — same crop (300x520): label column right-justified at 6..136, control column at 146, 20px row pitch, menu plate 0x060012b3 + arrow 0x060012b1', x: PANEL_X, y: PANEL_Y, w: 300, h: 520 },
];

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

function cropCell(p: Panel): string {
  return `<div class="cell"><div class="lbl">${p.label}</div>
    <div class="clip" style="width:${p.w * ZOOM}px;height:${p.h * ZOOM}px">
      <img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * ZOOM}px;top:${-p.y * ZOOM}px;transform-origin:0 0;transform:scale(${ZOOM});image-rendering:pixelated"/>
    </div></div>`;
}

function fullCell(file: string, label: string, w: number): string {
  return `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${w}px;display:block"/></div>`;
}

const STYLE = `<style>
  body{margin:0;background:#111;color:#ddd;font:12px/1.3 system-ui,sans-serif}
  .row{display:flex;gap:12px;padding:12px;align-items:flex-start}
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
  console.log(`[core17hd] wrote ${out}`);
}

async function main(): Promise<void> {
  for (const f of [RETAIL_CHAT, RETAIL_CONFIG, OURS_CHAT, OURS_CHAT_LOWERED, OURS_CONFIG]) {
    if (!existsSync(f)) throw new Error(`missing input: ${f}`);
  }
  mkdirSync(OUT, { recursive: true });
  for (const f of [OURS_CHAT, OURS_CHAT_LOWERED, OURS_CONFIG]) copyFileSync(f, join(OUT, f.split('/').pop()!));
  await shoot(
    `<div class="row">${CHAT_ROW.map(cropCell).join('')}</div><div class="row">${CONFIG_ROW.map(cropCell).join('')}</div>`,
    join(OUT, 'core17hd-options-sidebyside.png'), 1900,
  );
  await shoot(`<div class="row">
    ${fullCell(RETAIL_CHAT, 'retail EoL Chat tab (panel-only reference, 300x525)', 300)}
    ${fullCell(RETAIL_CONFIG, 'retail EoL Config tab (panel-only reference, 300x520)', 300)}
    ${fullCell(OURS_CHAT, 'ours — Chat tab over the world (whole screen)', 780)}
    ${fullCell(OURS_CONFIG, 'ours — Config tab over the world (whole screen)', 780)}
  </div>`, join(OUT, 'core17hd-fullscreen-sidebyside.png'), 2250);
}

main().catch((e) => { console.error(e); process.exit(1); });
