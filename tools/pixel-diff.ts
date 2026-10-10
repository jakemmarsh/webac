/**
 * Pixel diff via headless Chromium canvas (no native image deps in this env).
 * Usage: npx tsx tools/pixel-diff.ts a.png b.png [out-diff.png]
 * Prints differing-pixel count/percent and writes an optional red-highlight diff.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [a, b, out] = process.argv.slice(2);
if (!a || !b) { console.error('usage: pixel-diff a.png b.png [diff.png]'); process.exit(2); }

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage();
  const dataA = `data:image/png;base64,${readFileSync(a).toString('base64')}`;
  const dataB = `data:image/png;base64,${readFileSync(b).toString('base64')}`;
  const result = await page.evaluate(`(async () => {
    const ua = ${JSON.stringify(dataA)}; const ub = ${JSON.stringify(dataB)};
    const load = (u) => new Promise((res, rej) => {
      const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = u;
    });
    const [ia, ib] = await Promise.all([load(ua), load(ub)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { error: 'size mismatch: ' + ia.width + 'x' + ia.height + ' vs ' + ib.width + 'x' + ib.height };
    }
    const w = ia.width, h = ia.height;
    const cv = (img) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const da = cv(ia), db = cv(ib);
    const diffCanvas = document.createElement('canvas'); diffCanvas.width = w; diffCanvas.height = h;
    const dctx = diffCanvas.getContext('2d');
    const dimg = dctx.createImageData(w, h);
    let diff = 0, maxDelta = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      if (d > 0) {
        diff++;
        if (d > maxDelta) maxDelta = d;
        dimg.data[i] = 255; dimg.data[i + 3] = 255;
      } else {
        dimg.data[i] = da[i] >> 2; dimg.data[i + 1] = da[i + 1] >> 2; dimg.data[i + 2] = da[i + 2] >> 2; dimg.data[i + 3] = 255;
      }
    }
    dctx.putImageData(dimg, 0, 0);
    return { w, h, diff, total: w * h, maxDelta, png: diffCanvas.toDataURL('image/png') };
  })()`) as { error?: string; w?: number; h?: number; diff: number; total: number; maxDelta: number; png?: string };
  if ('error' in result) { console.error(result.error); process.exit(1); }
  const pct = (100 * result.diff / result.total).toFixed(3);
  console.log(`${a} vs ${b}: ${result.diff}/${result.total} px differ (${pct}%), max channel delta ${result.maxDelta}`);
  if (out && result.png) writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64'));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
