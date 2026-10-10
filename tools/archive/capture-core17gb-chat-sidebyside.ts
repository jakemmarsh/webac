/**
 * CORE.17.g.b — side-by-side evidence: existing chat log lines re-wrap when
 * the main chat window is resized (UIElement_Text::ResizeTo @ 00467a30
 * dirties the whole log text on any size change).
 *
 * Composes (no browser driving — the live captures come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-idle-over-world
 *  hud-chat-moved-resized hud-chat-narrowed hud-chat-maximized`, copied into
 * verification/core17gb/ as after-*.png):
 *
 *   core17gb-chat-sidebyside.png — 2x crops of the window:
 *     retail EoL client under Wine (normal 410-wide window: ACE's welcome
 *     wraps at "type" / "@acehelp") | ours BEFORE (CORE.17.g.a's
 *     moved+resized capture: 570 wide, the welcome line still split at the
 *     old 410 wrap) | ours AFTER moved+resized (re-wrapped at 570) |
 *     ours AFTER narrowed (330 wide: re-wrapped narrower, nothing clipped) |
 *     ours AFTER maximized (width unchanged → same wrap as normal)
 *
 *   core17gb-fullscreen-sidebyside.png — whole screens:
 *     retail Wine frame | ours before (moved+resized) | ours after
 *     (moved+resized) | ours after (narrowed)
 *
 * Usage: npx tsx tools/capture-core17gb-chat-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17gb');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const BEFORE_MOVED = join(REPO, 'verification/core17ga/after-hud-chat-moved-resized.png');
const NORMAL = join(OUT, 'after-hud-idle-over-world.png');
const MOVED = join(OUT, 'after-hud-chat-moved-resized.png');
const NARROWED = join(OUT, 'after-hud-chat-narrowed.png');
const MAXIMIZED = join(OUT, 'after-hud-chat-maximized.png');
const ZOOM = 2;

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

// Capture is 1568x775: normal window (0,675) 410x100; moved+resized (120,535)
// 570x140; narrowed (80,675) 330x100; maximized (0,288) 410x487.
const P = {
  wine: { file: WINE, label: 'retail EoL client (Wine, 1024x768) — normal 410 wide: welcome wraps at "type" / "@acehelp"', x: 0, y: 660, w: 430, h: 108 },
  normal: { file: NORMAL, label: 'ours — normal 410 wide (wrap at append time, unchanged)', x: 0, y: 670, w: 430, h: 105 },
  beforeMoved: { file: BEFORE_MOVED, label: 'ours BEFORE (CORE.17.g.a capture) — widened to 570: line still split at the old 410 wrap', x: 115, y: 530, w: 590, h: 150 },
  afterMoved: { file: MOVED, label: 'ours AFTER — widened to 570: every line re-wrapped at the new width', x: 115, y: 530, w: 590, h: 150 },
  narrowed: { file: NARROWED, label: 'ours AFTER — narrowed to 330 via the left grip: re-wrapped narrower, nothing clipped', x: 75, y: 670, w: 350, h: 105 },
  maximized: { file: MAXIMIZED, label: 'ours AFTER — maximized (width unchanged → nothing re-laid out, same wrap as normal)', x: 0, y: 283, w: 430, h: 492 },
} satisfies Record<string, Panel>;

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
  for (const f of [WINE, BEFORE_MOVED, NORMAL, MOVED, NARROWED, MAXIMIZED]) {
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
  await page.setContent(`${css}<h1>CORE.17.g.b — chat log re-wraps on resize: retail normal | ours normal | ours before/after widened | after narrowed | after maximized (${ZOOM}x crops)</h1>
    <div class="row">${cropCell(P.wine)}${cropCell(P.normal)}${cropCell(P.narrowed)}</div><div style="height:12px"></div>
    <div class="row">${cropCell(P.beforeMoved)}${cropCell(P.afterMoved)}</div><div style="height:12px"></div>
    <div class="row">${cropCell(P.maximized)}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17gb-chat-sidebyside.png'), fullPage: true });

  // 2. whole screens
  await page.setContent(`${css}<h1>CORE.17.g.b — whole-screen: retail EoL client (Wine 1024x768) | ours before (moved+resized) | ours after (moved+resized) | ours after (narrowed) (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE — moved + resized (CORE.17.g.a capture)</div><img src="${dataUrl(BEFORE_MOVED)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER — moved + resized</div><img src="${dataUrl(MOVED)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER — narrowed (left grip 0x1000069e)</div><img src="${dataUrl(NARROWED)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17gb-fullscreen-sidebyside.png'), fullPage: true });
  await br.close();
  console.log(`wrote ${join(OUT, 'core17gb-chat-sidebyside.png')} and core17gb-fullscreen-sidebyside.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
