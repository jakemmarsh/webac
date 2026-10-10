/**
 * probe-dialog-text-canvas — VISUAL.confirmation-dialog-text-glyphs: opens the
 * swear-allegiance confirmation dialog at 1600x900 and reports each text
 * canvas's backing size against its laid-out CSS size (a mismatch resamples
 * the bitmap-font glyphs), then screenshots the dialog.
 *
 * Usage: npx tsx tools/probe-dialog-text-canvas.ts [outDir]
 */
import { mkdirSync } from 'node:fs';
import { enterWorld, gameUrl } from './lib/game-session.js';

const OUT = process.argv[2] ?? 'verification/dialog-text-canvas';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const s = await enterWorld({ viewport: { width: 1600, height: 900 }, url: gameUrl({ cb: 'dlgtext' }) } as never);
  await s.page.waitForTimeout(2000);
  await s.page.evaluate(`window.__ac.gameUI.showConfirmationDialog('+Fxprobe would like to swear allegiance to you. Do you accept?', () => {})`);
  await s.page.waitForTimeout(500);
  const report = await s.page.evaluate(`(() => {
    const d = window.__ac.gameUI.confirmationDialog;
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { dpr: window.devicePixelRatio, dialog: [r.x, r.y, r.width, r.height], canvases: [...d.querySelectorAll('canvas')].map((c) => {
      const b = c.getBoundingClientRect(); const cs = getComputedStyle(c);
      let tr = ''; for (let e = c; e && e !== document.body; e = e.parentElement) { const t = getComputedStyle(e).transform; if (t && t !== 'none') tr += e.className + ':' + t + ' '; }
      return { w: c.width, h: c.height, cssW: b.width, cssH: b.height, x: b.x, y: b.y, style: c.getAttribute('style'), rendering: cs.imageRendering, transforms: tr };
    }) };
  })()`);
  console.log(JSON.stringify(report, null, 1));
  const box = (report as { dialog: number[] } | null)?.dialog;
  if (box) await s.page.screenshot({ path: `${OUT}/dialog.png`, clip: { x: box[0], y: box[1], width: box[2], height: box[3] } });
  await s.page.screenshot({ path: `${OUT}/full.png` });
  await s.browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
