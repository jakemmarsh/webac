/**
 * CORE.17.h.g.d — per-text-row ink extents of a retail reference screenshot
 * (bright glyph pixels, grouped into lines), used to pin the options label
 * font: in reference/images/hud/options-config.jpg the label rows measure
 * "Sound Features" 74 / "Camera Stiffness" 79 / "Camera Adjustment Speed"
 * 128 / "Field of View" 66 / "Resolution" 51 / "Screen Brightness" 84 /
 * "Adaptive Degrade Bias" 110 / "Full Screen" 54 / "Sync with Refresh Rate"
 * 112 px of ink with a 7px cap height — exactly the DAT font 0x40000002's
 * ink widths (74/79/128/66/51/84/110/54/112, 'E' 7 tall), not the 16px UI
 * font 0x40000000's (75/80/131/69/53/89/115/57/115, 'E' 8 tall); the
 * "Sound Options" header's 73 matches 0x40000000 (73). Every label ends at
 * x 136/137 = the 130px cell's far edge at page x 8.
 *
 * Usage: npx tsx tools/probe-core17hgd-retail-label-metrics.mts [file x0 x1 y0 y1]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file = process.argv[2] ?? 'reference/images/hud/options-config.jpg';
const x0 = Number(process.argv[3] ?? 0), x1 = Number(process.argv[4] ?? 142), y0 = Number(process.argv[5] ?? 30), y1 = Number(process.argv[6] ?? 520);
const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
const b64 = readFileSync(file).toString('base64');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setContent(`<canvas id=c></canvas><img id=i src="data:image/${ext};base64,${b64}">`);
const SRC = `new Promise((resolve) => {
  const img = document.getElementById('i');
  const go = () => {
    const c = document.getElementById('c'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const rows = [];
    for (let y = ${y0}; y < ${y1}; y++) {
      let minX = 1e9, maxX = -1, n = 0;
      for (let x = ${x0}; x < ${x1}; x++) {
        const i = (y * c.width + x) * 4; const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r > 190 && g > 170 && b > 110 && (r + g + b) > 560) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
      }
      if (n > 0) rows.push([y, minX, maxX, n]);
    }
    // group consecutive rows into text lines
    const lines = []; let cur = null;
    for (const [y, a, b, n] of rows) {
      if (cur && y === cur.y1 + 1) { cur.y1 = y; cur.x0 = Math.min(cur.x0, a); cur.x1 = Math.max(cur.x1, b); cur.n += n; }
      else { cur = { y0: y, y1: y, x0: a, x1: b, n }; lines.push(cur); }
    }
    resolve({ size: [c.width, c.height], lines: lines.map(l => ({ y: [l.y0, l.y1], h: l.y1 - l.y0 + 1, x: [l.x0, l.x1], w: l.x1 - l.x0 + 1, n: l.n })) });
  };
  if (img.complete) go(); else img.onload = go;
})`;
const res = await page.evaluate(SRC);
console.log(JSON.stringify(res));
await browser.close();
