/**
 * Signed per-channel mean difference (B − A) inside the ground band of two
 * same-size captures — tells a uniform exposure/lighting offset (all three
 * channels shifted the same way, small spread) from a texture/content change
 * (mean near zero, large spread).
 *
 * Usage: npx tsx tools/ab-signed-mean.ts <a.png> <b.png>
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const dataUrl = (f: string) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;

async function main(): Promise<void> {
  const [a, b] = process.argv.slice(2);
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage();
  const r = await page.evaluate(`(async () => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const A = await load(${JSON.stringify(dataUrl(a))});
    const B = await load(${JSON.stringify(dataUrl(b))});
    const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
    const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = px(A), pb = px(B);
    const x1 = Math.floor(w * 0.82), yWorld = Math.floor(h * 0.72), ySky = Math.floor(h * 0.40);
    const sum = [0, 0, 0], sq = [0, 0, 0]; let n = 0;
    for (let y = ySky; y < yWorld; y++) for (let x = 0; x < x1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) { const d = pb[i + c] - pa[i + c]; sum[c] += d; sq[c] += d * d; }
      n++;
    }
    const mean = sum.map((s) => s / n);
    const sd = sq.map((s, c) => Math.sqrt(s / n - mean[c] * mean[c]));
    return { n, mean, sd };
  })()`) as { n: number; mean: number[]; sd: number[] };
  console.log(`${a} -> ${b}: ground band n=${r.n} mean ΔRGB = [${r.mean.map((v) => v.toFixed(2)).join(', ')}] sd = [${r.sd.map((v) => v.toFixed(2)).join(', ')}]`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
