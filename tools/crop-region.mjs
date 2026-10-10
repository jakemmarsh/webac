// Crop + upscale a region of a capture PNG for close visual inspection.
// Uses headless Chromium (no native image deps) to offset+zoom an <img> and
// screenshot a clip. Handy for verifying a single HUD panel inside a full-screen
// capture (e.g. the inventory panel renders at screen x≈980, not the far right).
// Usage: node tools/crop-region.mjs <png|jpg> <x> <y> <w> <h> [scale] [out]  → out (default /tmp/crop-out.png)
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
const [img, x, y, w, h, s, out] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], +process.argv[6], +(process.argv[7] || 2), process.argv[8] || '/tmp/crop-out.png'];
const mime = /\.jpe?g$/i.test(img) ? 'jpeg' : 'png';
const b64 = readFileSync(img).toString('base64');
const br = await chromium.launch({
  args: ['--enable-unsafe-swiftshader'],
  // Remote env pre-installs Chromium here (see capture-ui-screens.ts).
  ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
});
const p = await br.newPage({ viewport: { width: w * s, height: h * s } });
await p.setContent(`<body style="margin:0;background:#000"><img id="i" src="data:image/${mime};base64,${b64}" style="position:absolute;left:${-x * s}px;top:${-y * s}px;image-rendering:pixelated"/></body>`);
await p.waitForTimeout(120);
// Scale the img to its OWN intrinsic width × s so 1 source px = s screen px —
// previously hardcoded 1568*s, which mis-cropped any non-1568-wide image
// (e.g. retail jpg refs render ~6x their actual size). (Folded in from the
// former scratch tools/crop2-tmp.mjs, deleted 2026-09-26.)
await p.evaluate((scale) => { const i = document.getElementById('i'); i.style.width = (i.naturalWidth * scale) + 'px'; }, s);
await p.waitForTimeout(50);
await p.screenshot({ path: out, clip: { x: 0, y: 0, width: w * s, height: h * s } });
await br.close();
console.log(`cropped → ${out}`);
