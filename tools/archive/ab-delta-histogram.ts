/**
 * Pixel-delta histogram for A/B scene captures (covenant evidence helper).
 *
 * The plain "pixels differing" count of capture-core17hgc-texture-prefs.ts
 * cannot separate a texture-sampling change from the session-to-session
 * noise of two separate logins (cloud drift — CORE.17.r — flickering
 * interior lights, wandering creatures, sub-pixel camera settle). This
 * prints, per band (whole frame / world / sky / ground), the distribution of
 * max-channel deltas in buckets 0 / 1-3 / 4-8 / 9-16 / 17-32 / 33-64 / 65+
 * and the mean |Δ|, so an A/B pair can be judged against a same-build
 * control pair captured the same way.
 *
 * Usage: npx tsx tools/ab-delta-histogram.ts <a.png> <b.png> [label]
 *        npx tsx tools/ab-delta-histogram.ts --dir verification/core17hgc
 *          (runs before/after, after/control and before/control for every
 *           scene that has all three files)
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BUCKETS = ['0', '1-3', '4-8', '9-16', '17-32', '33-64', '65+'];

interface BandStats { total: number; buckets: number[]; meanAbs: number; maxDelta: number }
export interface Histogram { all: BandStats; world: BandStats; sky: BandStats; ground: BandStats }

function dataUrl(file: string): string {
  return `data:image/png;base64,${readFileSync(file).toString('base64')}`;
}

async function histogram(page: Page, a: string, b: string): Promise<Histogram> {
  return page.evaluate(`(async () => {
    const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const A = await load(${JSON.stringify(dataUrl(a))});
    const B = await load(${JSON.stringify(dataUrl(b))});
    const w = Math.min(A.width, B.width), h = Math.min(A.height, B.height);
    const px = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const pa = px(A), pb = px(B);
    const x1 = Math.floor(w * 0.82), yWorld = Math.floor(h * 0.72), ySky = Math.floor(h * 0.40);
    const mk = () => ({ total: 0, buckets: [0, 0, 0, 0, 0, 0, 0], sum: 0, maxDelta: 0 });
    const all = mk(), world = mk(), ground = mk(), sky = mk();
    const bucket = (d) => d === 0 ? 0 : d <= 3 ? 1 : d <= 8 ? 2 : d <= 16 ? 3 : d <= 32 ? 4 : d <= 64 ? 5 : 6;
    const add = (s, d) => { s.total++; s.buckets[bucket(d)]++; s.sum += d; if (d > s.maxDelta) s.maxDelta = d; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      add(all, d);
      if (x < x1 && y < yWorld) { add(world, d); add(y < ySky ? sky : ground, d); }
    }
    const fin = (s) => ({ total: s.total, buckets: s.buckets, meanAbs: s.sum / Math.max(1, s.total), maxDelta: s.maxDelta });
    return { all: fin(all), world: fin(world), sky: fin(sky), ground: fin(ground) };
  })()`) as Promise<Histogram>;
}

export function formatHistogram(label: string, hist: Histogram): string {
  const lines = [`${label}`];
  for (const band of ['all', 'world', 'sky', 'ground'] as const) {
    const s = hist[band];
    const pct = s.buckets.map((n, i) => `${BUCKETS[i]}:${(n / s.total * 100).toFixed(1)}%`).join('  ');
    lines.push(`  ${band.padEnd(6)} mean|Δ| ${s.meanAbs.toFixed(2)}  max ${s.maxDelta}  ${pct}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage();
  const pairs: Array<[string, string, string]> = [];
  const dirIdx = argv.indexOf('--dir');
  if (dirIdx >= 0) {
    const dir = argv[dirIdx + 1];
    const scenes = readdirSync(dir).filter((f) => f.startsWith('before-') && f.endsWith('.png')).map((f) => f.slice(7, -4));
    for (const scene of scenes) {
      const before = join(dir, `before-${scene}.png`), after = join(dir, `after-${scene}.png`), control = join(dir, `control-${scene}.png`);
      if (existsSync(after)) pairs.push([before, after, `${scene}: BEFORE vs AFTER (code change)`]);
      if (existsSync(control)) pairs.push([after, control, `${scene}: AFTER vs CONTROL (same build, two sessions — noise floor)`]);
      if (existsSync(control)) pairs.push([before, control, `${scene}: BEFORE vs CONTROL`]);
    }
  } else {
    pairs.push([argv[0], argv[1], argv[2] ?? `${argv[0]} vs ${argv[1]}`]);
  }
  const out: Record<string, Histogram> = {};
  for (const [a, b, label] of pairs) {
    const h = await histogram(page, a, b);
    out[label] = h;
    console.log(formatHistogram(label, h));
  }
  await browser.close();
  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx >= 0) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(argv[jsonIdx + 1], JSON.stringify(out, null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
