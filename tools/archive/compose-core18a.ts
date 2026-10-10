/**
 * CORE.18.a — side-by-side sheet: the retail frame at the @teleloc heading vs
 * our arrival (no yaw override), plus the radar dial before / after while
 * facing north. Run from repo root after tools/capture-core18a-heading.ts:
 *   npx tsx tools/compose-core18a.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const AB = join(ROOT, 'verification', 'retail-client', 'ab');
const OUT = join(ROOT, 'verification', 'core18a');
const uri = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const RADAR = { x: 1470, y: 0, w: 130, h: 140 };
const radar = (p: string, cap: string) => `<figure><div class="crop" style="width:${RADAR.w * 2}px;height:${RADAR.h * 2}px"><img src="${uri(p)}" style="width:3200px;margin-left:-${RADAR.x * 2}px;margin-top:-${RADAR.y * 2}px"></div><figcaption>${cap}</figcaption></figure>`;
const full = (p: string, cap: string) => `<figure><img src="${uri(p)}" style="width:780px"><figcaption>${cap}</figcaption></figure>`;

const html = `<style>body{background:#111;color:#ddd;font:13px sans-serif;margin:0;padding:12px}h2{font-size:15px;margin:10px 0 6px}
.row{display:flex;gap:10px}figure{margin:0}.crop{overflow:hidden;border:1px solid #444}.crop img{display:block;max-width:none;image-rendering:pixelated}
figcaption{max-width:780px;font-size:11px;color:#bbb;margin-top:4px}</style>
<h2>CORE.18.a — '@teleloc 0xA9B40019 84.3 5.0 94 0.9969 0 0 -0.0785' (heading NNE), 1600x900</h2>
<div class="row">${full(join(AB, 'retail-holtburg.png'), 'RETAIL acclient.exe at the teleloc heading')}
${full(join(OUT, 'ours-core18a-teleloc-arrival.png'), 'OURS after the fix: the arrival alone turns the camera to the server heading (no setPlayerYaw); compass 9° (NNE)')}</div>
<div class="row" style="margin-top:8px">${full(join(AB, 'ours-chest-closed.png'), 'OURS before (GAP.retail-client-reference-frames): same teleloc, the view stays at yaw 0 and looks SOUTH')}</div>
<h2>Radar, facing north (x2)</h2>
<div class="row">${radar(join(AB, 'retail-holtburg.png'), 'RETAIL (NNE)')}
${existsSync(join(AB, 'ours-core18-facing-north.png')) ? radar(join(AB, 'ours-core18-facing-north.png'), 'OURS before: facing north, S at the top') : ''}
${radar(join(OUT, 'ours-core18a-facing-north.png'), 'OURS after: facing north, N at the top')}
${radar(join(OUT, 'ours-core18a-facing-east.png'), 'OURS after: facing east, E at the top')}</div>`;

(async () => {
  const b = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined });
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await p.setContent(html);
  await p.screenshot({ path: join(OUT, 'sbs-core18a.png'), fullPage: true });
  await b.close();
})();
