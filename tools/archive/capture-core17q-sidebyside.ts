/**
 * CORE.17.q evidence — sealed-interior lighting before/after next to the
 * retail dungeon references, plus per-region colour means.
 *
 * Inputs: verification/core17q/before-world-dungeon.png,
 *         verification/core17q/after-world-dungeon.png
 *         (tools/capture-ui-screens.ts --scenes world-dungeon, copied per run),
 *         reference/images/hud/rawg_02.jpg, rawg_04.jpg, rawg_09.jpg.
 * Outputs: verification/core17q/core17q-dungeon-sidebyside.png (2x2: before,
 *          after, two retail frames), core17q-samples.json (region means).
 *
 * No PNG library in the repo: a headless Chromium page decodes + composites
 * (same approach as capture-core17e-sidebyside.ts).
 *
 *   npx tsx tools/capture-core17q-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname ?? process.cwd(), '..', '..');
const DIR = join(ROOT, 'verification', 'core17q');
const REFS = join(ROOT, 'reference', 'images', 'hud');

// 1568x775 scene captures: the 3D view minus the HUD strips.
const REGIONS: Record<string, [number, number, number, number]> = {
  world: [160, 60, 1400, 660],
  ceiling: [300, 70, 1300, 170],
  leftWall: [60, 300, 500, 520],
  rightWall: [1000, 300, 1440, 520],
  nearFloor: [400, 580, 1200, 670],
  farCorridor: [700, 300, 900, 420],
};

const lum = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

async function main(): Promise<void> {
  const before = join(DIR, 'before-world-dungeon.png');
  const after = join(DIR, 'after-world-dungeon.png');
  for (const p of [before, after]) {
    if (!existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
  }
  const refFiles = ['rawg_04.jpg', 'rawg_09.jpg'].map((f) => join(REFS, f)).filter(existsSync);

  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');

  const inputs = [
    { label: 'BEFORE — world-dungeon (placeholder: white 0.8 fill + 0.25 ambient, 0x111111 fog 5..60, 0xffcc88 camera torch)', src: `data:image/png;base64,${readFileSync(before).toString('base64')}`, sample: 'before' },
    { label: 'AFTER — world-dungeon (CORE.17.q: sky-curve ambient, no sun, DAT static lights ×1.5 range, retail viewer light, sky fog, black clear)', src: `data:image/png;base64,${readFileSync(after).toString('base64')}`, sample: 'after' },
    ...refFiles.map((f, i) => ({ label: `RETAIL — ${f.split('/').pop()} (reference/images/hud)`, src: `data:image/jpeg;base64,${readFileSync(f).toString('base64')}`, sample: `ref${i}` })),
  ];

  const result = await page.evaluate(async ({ inputs, regions }) => {
    const imgs = await Promise.all(inputs.map((p) => new Promise<HTMLImageElement>((res) => {
      const im = new Image(); im.onload = () => res(im); im.src = p.src;
    })));
    const W = imgs[0].naturalWidth, H = imgs[0].naturalHeight;
    const PAD = 12, LABEL = 22;
    const cols = 2, rows = Math.ceil(imgs.length / cols);
    const c = document.createElement('canvas');
    c.width = (W + PAD) * cols + PAD; c.height = (H + LABEL + PAD) * rows + PAD;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = '15px sans-serif';
    const means: Record<string, Record<string, number[]>> = {};
    imgs.forEach((im, i) => {
      const x = PAD + (i % cols) * (W + PAD);
      const y = PAD + Math.floor(i / cols) * (H + LABEL + PAD);
      ctx.fillStyle = '#eee'; ctx.fillText(inputs[i].label, x, y + 16);
      // refs are 800x600 / 1024x768 — scale to the capture width, keep aspect
      const s = Math.min(W / im.naturalWidth, H / im.naturalHeight);
      ctx.drawImage(im, x, y + LABEL, im.naturalWidth * s, im.naturalHeight * s);
      if (i < 2) {
        const sc = document.createElement('canvas'); sc.width = im.naturalWidth; sc.height = im.naturalHeight;
        const sctx = sc.getContext('2d')!; sctx.drawImage(im, 0, 0);
        const m: Record<string, number[]> = {};
        for (const [name, [x0, y0, x1, y1]] of Object.entries(regions)) {
          const d = sctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          let r = 0, g = 0, b = 0; const n = d.length / 4;
          for (let k = 0; k < d.length; k += 4) { r += d[k]; g += d[k + 1]; b += d[k + 2]; }
          m[name] = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        }
        means[inputs[i].sample] = m;
      }
    });
    return { png: c.toDataURL('image/png'), means };
  }, { inputs, regions: REGIONS });

  const out = join(DIR, 'core17q-dungeon-sidebyside.png');
  writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64'));
  console.log(out);
  for (const region of Object.keys(REGIONS)) {
    const b = result.means.before[region], a = result.means.after[region];
    console.log(`  ${region.padEnd(12)} before=(${b}) lum=${lum(b).toFixed(0).padStart(3)}  after=(${a}) lum=${lum(a).toFixed(0).padStart(3)}`);
  }
  writeFileSync(join(DIR, 'core17q-samples.json'), JSON.stringify({ regions: REGIONS, samples: result.means }, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
