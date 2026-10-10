/**
 * CORE.17.h — side-by-side evidence for the main chat window opacity.
 *
 * Composes (no browser driving — the live capture comes from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-idle-over-world`):
 *
 *   core17h-chat-sidebyside.png
 *     retail EoL client under Wine, 1024x768 (docs/images/
 *     retail-client-wine-inworld-holtburg.png) chat crop (3x)
 *     | retail 1920x1080 shutdown capture (reference/images/hud/
 *       reddit-shutdown.jpg) chat crop (3x)
 *     | ours BEFORE (0x2100006f at the invented 40% inactive opacity) (3x)
 *     | ours AFTER (gmMainChatUI ctor 1.0 — the tile's own alpha) (3x)
 *
 *   core17h-fullscreen-sidebyside.png
 *     retail Wine frame | ours before | ours after — whole screens.
 *
 * Retail crop boxes (bottom-left, window 410x100 at native size):
 *   Wine 1024x768:  x 0, y 660, 430x108
 *   reddit 1920x1080: x 0, y 975, 430x105
 * Ours (1568x775 capture): x 0, y 670, 430x105.
 *
 * Usage: npx tsx tools/capture-core17h-chat-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17h');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const REDDIT = join(REPO, 'reference/images/hud/reddit-shutdown.jpg');
const BEFORE = join(OUT, 'before-hud-idle-over-world.png');
const AFTER = join(OUT, 'after-hud-idle-over-world.png');
const ZOOM = 3;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

const PANELS: Panel[] = [
  { file: WINE, label: 'retail EoL client (Wine, 1024x768) — body coverage 0.69', x: 0, y: 660, w: 430, h: 108 },
  { file: REDDIT, label: 'retail 1920x1080 (reddit-shutdown) — body coverage 0.68', x: 0, y: 975, w: 430, h: 105 },
  { file: BEFORE, label: 'ours BEFORE — 40% inactive opacity baked into the tile (coverage 0.21)', x: 0, y: 670, w: 430, h: 105 },
  { file: AFTER, label: 'ours AFTER — gmMainChatUI ctor 1.0, tile alpha 175/255 (coverage 0.66)', x: 0, y: 670, w: 430, h: 105 },
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

async function main(): Promise<void> {
  for (const f of [WINE, REDDIT, BEFORE, AFTER]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const css = `<style>
    body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
    .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{color:#ffd;white-space:nowrap}
    .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
    .full img{display:block;width:780px;height:auto;border:1px solid #444}
    h1{font-size:14px;margin:0 0 8px}
  </style>`;
  const br = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await br.newPage({ viewport: { width: 2700, height: 1000 } });

  await page.setContent(`${css}<h1>CORE.17.h — main chat body opacity, retail vs ours (${ZOOM}x crops, bottom-left of each frame)</h1>
    <div class="row">${cropCell(PANELS[0])}${cropCell(PANELS[1])}</div><div style="height:12px"></div>
    <div class="row">${cropCell(PANELS[2])}${cropCell(PANELS[3])}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17h-chat-sidebyside.png'), fullPage: true });

  await page.setContent(`${css}<h1>CORE.17.h — whole-screen: retail EoL client (Wine 1024x768) | ours before | ours after (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img src="${dataUrl(AFTER)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17h-fullscreen-sidebyside.png'), fullPage: true });
  await br.close();
  console.log(`wrote ${join(OUT, 'core17h-chat-sidebyside.png')} and core17h-fullscreen-sidebyside.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
