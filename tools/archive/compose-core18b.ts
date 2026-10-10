/**
 * CORE.18.b — side-by-side sheet: the retail frame at the @teleloc spot and
 * heading vs ours with the retail camera rig, and ours before (CORE.18.a's
 * arrival: 5 m boom at eye height, 90° vertical FOV). Run from repo root
 * after tools/capture-core18b-camera.ts:
 *   npx tsx tools/compose-core18b.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const AB = join(ROOT, 'verification', 'retail-client', 'ab');
const OUT = join(ROOT, 'verification', 'core18b');
const uri = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const full = (p: string, cap: string) => `<figure><img src="${uri(p)}" style="width:780px"><figcaption>${cap}</figcaption></figure>`;

const html = `<style>body{background:#111;color:#ddd;font:13px sans-serif;margin:0;padding:12px}h2{font-size:15px;margin:10px 0 6px}
.row{display:flex;gap:10px}figure{margin:0}figcaption{max-width:780px;font-size:11px;color:#bbb;margin-top:4px}</style>
<h2>CORE.18.b — default 3rd-person camera, '@teleloc 0xA9B40019 84.3 5.0 94 0.9969 0 0 -0.0785', 1600x900</h2>
<div class="row">${full(join(AB, 'retail-holtburg.png'), 'RETAIL acclient.exe')}
${full(join(OUT, 'ours-core18b-default.png'), 'OURS after: pivot 1.5 m, viewer (0, −2.75, 0.825), looking at the pivot (−16.7°), vertical FOV 90/(aspect−0.1) = 53.6°')}</div>
<div class="row" style="margin-top:8px">${full(join(ROOT, 'verification', 'core18a', 'ours-core18a-teleloc-arrival.png'), 'OURS before: 5 m boom at eye height 1.8 m, level, 90° vertical FOV')}
${full(join(OUT, 'ours-core18b-out3.png'), 'OURS after, 3 wheel notches out (× 1.2 per CameraSet::Farther step; boom keeps its angle)')}</div>`;

(async () => {
  const b = await chromium.launch({ executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined });
  const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
  await p.setContent(html);
  await p.screenshot({ path: join(OUT, 'sbs-core18b.png'), fullPage: true });
  await b.close();
})();
