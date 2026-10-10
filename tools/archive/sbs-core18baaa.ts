/**
 * CORE.18.b.a.a.a — side-by-side: retail A/B frame | ours default at rest
 * (orbit 0: unchanged) | lowered into the level-look band, orbit 0 / 17°
 * (|x| < 1: still looks along the player) / 90° (looks at the pivot, align
 * off) | running up a 31° dungeon ramp (the BSP floor's plane now tilts
 * the frame). Half-scale 2x3.
 *
 *   npx tsx tools/sbs-core18baaa.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V = join(ROOT, 'verification');
const panes: [string, string][] = [
  ['retail (EoL, same spot + heading)', join(V, 'retail-client/ab/retail-holtburg.png')],
  ['ours — default at rest, 1600x900 (orbit 0: unchanged, 2.75 m back, −16.7°)', join(V, 'core18baaa/ours-core18baaa-default.png')],
  ['ours — viewer lowered to z 0.55 (level band), orbit 0: looks level along the player', join(V, 'core18baaa/ours-core18baaa-orbit-level-0.png')],
  ['ours — same, orbit 17° (|x| 0.83 < 1): view yaw stays the player\'s (−171°)', join(V, 'core18baaa/ours-core18baaa-orbit-small.png')],
  ['ours — orbit 90° (|x| ≥ 1): LOOK_AT_PIVOT, align off, view yaw −81°', join(V, 'core18baaa/ours-core18baaa-orbit-quarter.png')],
  ['ours — running up a 31° dungeon ramp (0x8602): frame pitch +31°, view +14°', join(V, 'core18baaa/ours-core18baaa-dungeon-slope-480x270.png')],
];
const img = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const html = `<body style="margin:0;background:#111;font:16px sans-serif;color:#eee;display:grid;grid-template-columns:800px 800px;gap:4px">
${panes.map(([l, p]) => `<div><div style="padding:4px">${l}</div><img src="${img(p)}" style="width:800px;height:450px;display:block"></div>`).join('')}</body>`;
const browser = await chromium.launch(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const page = await browser.newPage({ viewport: { width: 1604, height: 1440 } });
await page.setContent(html);
await page.screenshot({ path: join(V, 'core18baaa/sbs-core18baaa.png'), fullPage: true });
await browser.close();
