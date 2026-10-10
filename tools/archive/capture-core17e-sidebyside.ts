/**
 * CORE.17.e evidence — before/after night+day scene composites plus the
 * sky/ground luminance table the gestalt audit measured the defect with.
 *
 * Inputs: verification/core17e/{before,after}/world-{night,town-day,dawn}.png
 * (written by tools/capture-ui-screens.ts --scenes, copied per run).
 * Outputs: verification/core17e/core17e-night-before-after.png,
 *          core17e-day-before-after.png, core17e-dawn-before-after.png,
 *          core17e-samples.json (means per region, before vs after).
 *
 * No PNG library in the repo: a headless Chromium page does the decoding and
 * compositing (same approach as capture-core17d-radar-sidebyside.ts).
 *
 *   npx tsx tools/capture-core17e-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? process.cwd(), '..', '..');
const DIR = join(ROOT, 'verification', 'core17e');
const SCENES = ['world-night', 'world-town-day', 'world-dawn'] as const;

// The audit's sample regions (1568x775 captures): open sky, mid ground, near ground.
const REGIONS: Record<string, [number, number, number, number]> = {
  sky: [300, 60, 1300, 250],
  ground: [500, 500, 1100, 700],
  nearGrass: [600, 650, 900, 740],
  farTrees: [200, 250, 700, 330],
  character: [770, 400, 810, 470],
};

async function main(): Promise<void> {
  // Cloud containers preinstall Chromium at /opt/pw-browsers/chromium (see
  // capture-ui-screens.ts); fall back to Playwright's own resolution locally.
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  const samples: Record<string, Record<string, Record<string, number[]>>> = {};

  for (const scene of SCENES) {
    const before = join(DIR, 'before', `${scene}.png`);
    const after = join(DIR, 'after', `${scene}.png`);
    if (!existsSync(before) || !existsSync(after)) { console.log(`skip ${scene}: missing before/after`); continue; }
    const inputs = [
      { label: `BEFORE — ${scene}`, src: `data:image/png;base64,${readFileSync(before).toString('base64')}` },
      { label: `AFTER — ${scene} (CORE.17.e: RegionDesc-only lighting, retail equation)`, src: `data:image/png;base64,${readFileSync(after).toString('base64')}` },
    ];
    const result = await page.evaluate(async ({ inputs, regions }) => {
      const imgs = await Promise.all(inputs.map((p) => new Promise<HTMLImageElement>((res) => {
        const im = new Image(); im.onload = () => res(im); im.src = p.src;
      })));
      const W = imgs[0].naturalWidth, H = imgs[0].naturalHeight;
      const PAD = 12, LABEL = 22;
      const c = document.createElement('canvas'); c.width = W + PAD * 2; c.height = (H + LABEL + PAD) * 2 + PAD;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.font = '16px sans-serif';
      const means: Record<string, Record<string, number[]>> = {};
      imgs.forEach((im, i) => {
        const y = PAD + i * (H + LABEL + PAD);
        ctx.fillStyle = '#eee'; ctx.fillText(inputs[i].label, PAD, y + 16);
        ctx.drawImage(im, PAD, y + LABEL);
        const sc = document.createElement('canvas'); sc.width = im.naturalWidth; sc.height = im.naturalHeight;
        const sctx = sc.getContext('2d')!; sctx.drawImage(im, 0, 0);
        const m: Record<string, number[]> = {};
        for (const [name, [x0, y0, x1, y1]] of Object.entries(regions)) {
          const d = sctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          let r = 0, g = 0, b = 0, n = d.length / 4;
          for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; }
          m[name] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        }
        means[i === 0 ? 'before' : 'after'] = m;
      });
      return { png: c.toDataURL('image/png'), means };
    }, { inputs, regions: REGIONS });
    const out = join(DIR, `core17e-${scene.replace('world-', '')}-before-after.png`);
    writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64'));
    samples[scene] = result.means;
    console.log(out);
    for (const region of Object.keys(REGIONS)) {
      const b = result.means.before[region], a = result.means.after[region];
      const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      console.log(`  ${scene.padEnd(15)} ${region.padEnd(10)} before=(${b}) lum=${lum(b).toFixed(0).padStart(3)}  after=(${a}) lum=${lum(a).toFixed(0).padStart(3)}`);
    }
  }
  writeFileSync(join(DIR, 'core17e-samples.json'), JSON.stringify({ regions: REGIONS, samples }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
