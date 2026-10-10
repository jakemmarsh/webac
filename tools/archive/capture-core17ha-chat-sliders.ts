/**
 * CORE.17.h.a — side-by-side evidence for the Chat Options opacity sliders.
 *
 * Composes (no browser driving — the live captures come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-options-chat
 * hud-options-chat-active-lowered`):
 *
 *   core17ha-chat-sliders-sidebyside.png
 *     retail Chat tab (reference/images/hud/chat-options.jpg, panel-only
 *     capture, 300x525) "General Chat Options" crop (2x)
 *     | ours, fresh character — no PlayerModule option: Inactive at the DAT
 *       default midpoint (0x78000001: 0.5), Active at Opaque (1.0) (2x)
 *     | ours after dragging Active to 30% — the linked Inactive thumb
 *       followed it down (gmChatOptionsUI::OnOptionChanged @ 0049f5d0) (2x)
 *
 *   core17ha-fullscreen-sidebyside.png
 *     retail panel | ours default whole screen | ours lowered whole screen —
 *     the whole-screen row also shows the main chat window (bottom-left)
 *     re-reading the options live: fully opaque by default (gmMainChatUI ctor
 *     1.0/1.0), 0.3 over the world once the option exists.
 *
 * Crop boxes (ours: 1568x775 scene capture, options panel docked right):
 *   panel top incl. the two sliders: x 1268, y 140, 300x150
 *   retail chat-options.jpg:         x 0,    y 0,   300x110
 *
 * Usage: npx tsx tools/capture-core17ha-chat-sliders.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17ha');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const RETAIL = join(REPO, 'reference/images/hud/chat-options.jpg');
const OURS_DEFAULT = join(SCENES, 'hud-options-chat.png');
const OURS_LOWERED = join(SCENES, 'hud-options-chat-active-lowered.png');
const ZOOM = 2;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

const PANELS: Panel[] = [
  { file: RETAIL, label: 'retail EoL Chat tab (chat-options.jpg) — Inactive at the midpoint, Active at Opaque', x: 0, y: 0, w: 300, h: 110 },
  { file: OURS_DEFAULT, label: 'ours, fresh character (no option 0x10000080/81) — DAT GameplayOptionDefaults 0.5 / 1.0', x: 1268, y: 140, w: 300, h: 150 },
  { file: OURS_LOWERED, label: 'ours after dragging Active to 30% — linked Inactive follows down (OnOptionChanged @ 0049f5d0)', x: 1268, y: 140, w: 300, h: 150 },
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

async function shoot(html: string, out: string): Promise<void> {
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1900, height: 700 } });
  await page.setContent(STYLE + html);
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(`[core17ha] wrote ${out}`);
}

async function main(): Promise<void> {
  for (const f of [RETAIL, OURS_DEFAULT, OURS_LOWERED]) {
    if (!existsSync(f)) throw new Error(`missing input: ${f}`);
  }
  mkdirSync(OUT, { recursive: true });
  copyFileSync(OURS_DEFAULT, join(OUT, 'hud-options-chat.png'));
  copyFileSync(OURS_LOWERED, join(OUT, 'hud-options-chat-active-lowered.png'));
  await shoot(`<div class="row">${PANELS.map(cropCell).join('')}</div>`, join(OUT, 'core17ha-chat-sliders-sidebyside.png'));
  await shoot(`<div class="row">
    ${fullCell(RETAIL, 'retail EoL Chat tab (panel-only reference, 300x525)', 300)}
    ${fullCell(OURS_DEFAULT, 'ours — Chat tab over the world, fresh character (main chat fully opaque: gmMainChatUI ctor 1.0/1.0)', 780)}
    ${fullCell(OURS_LOWERED, 'ours — Active dragged to 30%: Inactive follows, main chat re-reads the option live (0.3 over the world)', 780)}
  </div>`, join(OUT, 'core17ha-fullscreen-sidebyside.png'));
}

main().catch((e) => { console.error(e); process.exit(1); });
