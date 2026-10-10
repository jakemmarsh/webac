/**
 * CORE.17.g.a — side-by-side evidence for the main chat window's maximize
 * box + drag/resize borders.
 *
 * Composes (no browser driving — the live captures come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-idle-over-world
 *  hud-chat-maximized hud-chat-moved-resized`, copied into
 * verification/core17ga/ as after-*.png):
 *
 *   core17ga-chat-sidebyside.png — 3x crops of the window:
 *     retail EoL client under Wine (normal window, the only retail state on
 *     file) | ours normal | ours MAXIMIZED (grown up by screenH/2, box art
 *     0x06005e64) | ours MOVED + RESIZED (top bar drag, bottom-right grip)
 *
 *   core17ga-fullscreen-sidebyside.png — whole screens:
 *     retail Wine frame | ours normal | ours maximized | ours moved+resized
 *
 * The "before" state is CORE.17.g's after (verification/core17g/
 * after-hud-idle-over-world.png): identical chrome with inert controls, so
 * the normal-state crop doubles as the before.
 *
 * Usage: npx tsx tools/capture-core17ga-chat-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17ga');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const NORMAL = join(OUT, 'after-hud-idle-over-world.png');
const MAXIMIZED = join(OUT, 'after-hud-chat-maximized.png');
const MOVED = join(OUT, 'after-hud-chat-moved-resized.png');
const ZOOM = 2;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

// Capture is 1568x775: normal window (0,675) 410x100; maximized (0,288)
// 410x487; moved+resized (120,535) 570x140.
const PANELS: Panel[] = [
  { file: WINE, label: 'retail EoL client (Wine, 1024x768) — normal', x: 0, y: 660, w: 430, h: 108 },
  { file: NORMAL, label: 'ours — normal (before = CORE.17.g after; controls now live)', x: 0, y: 670, w: 430, h: 105 },
  { file: MAXIMIZED, label: 'ours — MAXIMIZED (0,288) 410x487: +screenH/2, grown upward', x: 0, y: 283, w: 430, h: 492 },
  { file: MOVED, label: 'ours — MOVED (+120,-140) + RESIZED (+160,+40): (120,535) 570x140', x: 115, y: 530, w: 590, h: 150 },
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
  for (const f of [WINE, NORMAL, MAXIMIZED, MOVED]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const css = `<style>
    body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
    .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{color:#ffd;white-space:nowrap}
    .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
    .full img{display:block;width:640px;height:auto;border:1px solid #444}
    h1{font-size:14px;margin:0 0 8px}
  </style>`;
  const br = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await br.newPage({ viewport: { width: 2700, height: 1200 } });

  // 1. window crops
  await page.setContent(`${css}<h1>CORE.17.g.a — main chat window: retail normal vs ours normal / maximized / moved+resized (${ZOOM}x crops)</h1>
    <div class="row">${cropCell(PANELS[0])}${cropCell(PANELS[1])}${cropCell(PANELS[3])}</div><div style="height:12px"></div>
    <div class="row">${cropCell(PANELS[2])}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17ga-chat-sidebyside.png'), fullPage: true });

  // 2. whole screens
  await page.setContent(`${css}<h1>CORE.17.g.a — whole-screen: retail EoL client (Wine 1024x768) | ours normal | ours maximized | ours moved+resized (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours — normal</div><img src="${dataUrl(NORMAL)}"/></div>
      <div class="cell"><div class="lbl">ours — maximized (box 0x1000046f)</div><img src="${dataUrl(MAXIMIZED)}"/></div>
      <div class="cell"><div class="lbl">ours — moved + resized (bar 0x1000069c, grip 0x100006a1)</div><img src="${dataUrl(MOVED)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17ga-fullscreen-sidebyside.png'), fullPage: true });
  await br.close();
  console.log(`wrote ${join(OUT, 'core17ga-chat-sidebyside.png')} and core17ga-fullscreen-sidebyside.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
