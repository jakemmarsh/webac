/**
 * CORE.17.h.b — side-by-side evidence for the main chat activation gate.
 *
 * Composes (no game driving — the live captures come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-chat-inactive-opacity-idle
 * hud-chat-inactive-opacity-entry-active hud-chat-inactive-opacity-after-send`):
 *
 *   core17hb-chat-activation-sidebyside.png
 *     retail main chat (reference/images/hud/reddit-shutdown.jpg, bottom-left
 *     410x100 — no option set, so the 1.0/1.0 constructor level) (2x)
 *     | ours, option 0x10000080 = 0.5 present, nothing activated → inactive
 *       level (2x)
 *     | ours, entry activated (Activate + TakeFocus) → active level 1.0 (2x)
 *     | ours, after Send with stay-in-chat off (HandleEnterKey @ 004f52d0:
 *       RelinquishFocus + Deactivate) → back at the inactive level (2x)
 *
 *   core17hb-fullscreen-sidebyside.png — the three whole-screen scenes.
 *
 * Also prints the mean luminance of the message-area body (inside the window,
 * away from the text) for each crop, so "dimmer" is a number: at opacity 0.5
 * the black tile blends half-way to the grass behind it.
 *
 * Usage: npx tsx tools/capture-core17hb-chat-activation.ts
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hb');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const RETAIL = join(REPO, 'reference/images/hud/reddit-shutdown.jpg');
const OURS = {
  idle: join(SCENES, 'hud-chat-inactive-opacity-idle.png'),
  active: join(SCENES, 'hud-chat-inactive-opacity-entry-active.png'),
  afterSend: join(SCENES, 'hud-chat-inactive-opacity-after-send.png'),
};
const ZOOM = 2;
const CHAT = { w: 410, h: 100 };

interface Panel { file: string; label: string; imgH: number }

const PANELS: Panel[] = [
  { file: RETAIL, label: 'retail EoL main chat (reddit-shutdown.jpg, 1920x1080) — no option 0x10000080/81: gmMainChatUI ctor 1.0/1.0, so no activation dim is visible', imgH: 1080 },
  { file: OURS.idle, label: 'ours — option 0x10000080 = 0.5 present, nothing activated (inactive level: whole window at 0.5)', imgH: 775 },
  { file: OURS.active, label: 'ours — entry activated (focus = Activate + TakeFocus): IsTextEntryFocused true → active level 1.0', imgH: 775 },
  { file: OURS.afterSend, label: 'ours — after Send with Stay-in-chat OFF (HandleEnterKey @ 004f52d0: RelinquishFocus + Deactivate) → inactive level again', imgH: 775 },
];

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

function cropCell(p: Panel, idx: number): string {
  const y = p.imgH - CHAT.h;
  return `<div class="cell"><div class="lbl">${p.label}</div>
    <div class="clip" style="width:${CHAT.w * ZOOM}px;height:${CHAT.h * ZOOM}px">
      <img id="crop${idx}" data-y="${y}" src="${dataUrl(p.file)}" style="position:absolute;left:0;top:${-y * ZOOM}px;transform-origin:0 0;transform:scale(${ZOOM});image-rendering:pixelated"/>
    </div></div>`;
}

function fullCell(file: string, label: string, w: number): string {
  return `<div class="cell"><div class="lbl">${label}</div><img src="${dataUrl(file)}" style="width:${w}px;display:block"/></div>`;
}

const STYLE = `<style>
  body{margin:0;background:#111;color:#ddd;font:12px/1.3 system-ui,sans-serif}
  .row{display:flex;gap:12px;padding:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{max-width:820px;color:#ccc}
  .clip{position:relative;overflow:hidden;background:#000}
</style>`;

async function shoot(html: string, out: string, measure: boolean): Promise<void> {
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1720, height: 700 } });
  await page.setContent(STYLE + html);
  await page.waitForTimeout(300);
  if (measure) {
    // Message-area body sample: inside the 400x73 tile (5,5)-(405,78) of the
    // 410x100 window, right half (x 220..390, y 10..70) — the log text sits
    // on the left in every capture, so this band is the plain tile over grass.
    const stats = await page.evaluate(`(function(){
      var out = [];
      for (var i = 0; ; i++) {
        var img = document.getElementById('crop' + i);
        if (!img) break;
        var y0 = parseInt(img.getAttribute('data-y'), 10);
        var c = document.createElement('canvas'); c.width = 410; c.height = 100;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, y0, 410, 100, 0, 0, 410, 100);
        var d = ctx.getImageData(220, 10, 170, 60).data, sum = 0, n = 0;
        for (var k = 0; k < d.length; k += 4) { sum += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]; n++; }
        var g = ctx.getImageData(0, 0, 410, 100);
        out.push({ crop: i, bodyLuma: +(sum / n).toFixed(1), pixels: n, w: g.width });
      }
      return out;
    })()`);
    console.log('[core17hb] message-area body luminance (0..255):', JSON.stringify(stats));
  }
  await page.screenshot({ path: out, fullPage: true });
  await browser.close();
  console.log(`[core17hb] wrote ${out}`);
}

async function main(): Promise<void> {
  for (const f of [RETAIL, OURS.idle, OURS.active, OURS.afterSend]) {
    if (!existsSync(f)) throw new Error(`missing input: ${f}`);
  }
  mkdirSync(OUT, { recursive: true });
  for (const [k, f] of Object.entries(OURS)) copyFileSync(f, join(OUT, `${k}.png`));
  await shoot(`<div class="row">${PANELS.map(cropCell).join('')}</div>`, join(OUT, 'core17hb-chat-activation-sidebyside.png'), true);
  await shoot(`<div class="row">
    ${fullCell(OURS.idle, 'ours — Inactive Opacity 0.5 present, nothing activated (whole screen)', 840)}
    ${fullCell(OURS.active, 'ours — entry activated → active level (whole screen)', 840)}
    ${fullCell(OURS.afterSend, 'ours — after Send, stay-in-chat off → inactive level (whole screen)', 840)}
  </div>`, join(OUT, 'core17hb-fullscreen-sidebyside.png'), false);
}

main().catch((e) => { console.error(e); process.exit(1); });
