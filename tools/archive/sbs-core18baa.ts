/**
 * CORE.18.b.a.a — side-by-side: retail A/B frame | ours default (unchanged at
 * rest) | ours running (the viewer trails at t_stiffness) | ours running
 * uphill with Align camera to slope ON | OFF. 480x270 panes are the
 * SwiftShader frames the ease is observable in (~6 fps; 1600x900 runs ~1.5
 * fps, where the blend clamps to 1). Half-scale 2x3.
 *
 *   npx tsx tools/sbs-core18baa.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V = join(ROOT, 'verification');
const panes: [string, string][] = [
  ['retail (EoL, same spot + heading)', join(V, 'retail-client/ab/retail-holtburg.png')],
  ['ours — default at rest, 1600x900 (unchanged: 2.75 m back, −16.7°)', join(V, 'core18baa/ours-core18baa-default.png')],
  ['ours — at rest, 480x270', join(V, 'core18baa/ours-core18baa-default-480x270.png')],
  ['ours — running: viewer trails ~0.25 m (t_stiffness 0.45)', join(V, 'core18baa/ours-core18baa-running-480x270.png')],
  ['ours — uphill 20–28°, Align camera to slope ON: boom tilts with the ground', join(V, 'core18baa/ours-core18baa-uphill-align-on-480x270.png')],
  ['ours — same run, Align camera to slope OFF: level boom, −16.7°', join(V, 'core18baa/ours-core18baa-uphill-align-off-480x270.png')],
];
const img = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const html = `<body style="margin:0;background:#111;font:16px sans-serif;color:#eee;display:grid;grid-template-columns:800px 800px;gap:4px">
${panes.map(([l, p]) => `<div><div style="padding:4px">${l}</div><img src="${img(p)}" style="width:800px;height:450px;display:block"></div>`).join('')}</body>`;
const browser = await chromium.launch(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const page = await browser.newPage({ viewport: { width: 1604, height: 1440 } });
await page.setContent(html);
await page.screenshot({ path: join(V, 'core18baa/sbs-core18baa.png'), fullPage: true });
await browser.close();
