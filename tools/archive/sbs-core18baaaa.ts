/**
 * CORE.18.b.a.a.a.a — side-by-side: retail A/B frame | ours default |
 * Overhead View | First Person after a right-drag (the player turned) |
 * Target In View tracking | tracking off. 2x3. No retail frame of the
 * overhead view or of combat tracking exists in reference/images; those
 * panes are checked against the decompiled formulas (state JSON).
 *
 *   npx tsx tools/sbs-core18baaaa.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V = join(ROOT, 'verification');
const panes: [string, string][] = [
  ['retail (EoL, same spot + heading)', join(V, 'retail-client/ab/retail-holtburg.png')],
  ['ours — default at rest (unchanged: 2.75 m back, −16.7°)', join(V, 'core18baaaa/ours-core18baaaa-default.png')],
  ['ours — Overhead View (Numpad5, LookDown): (0, −2, 0.75), view −74.5°', join(V, 'core18baaaa/ours-core18baaaa-overhead.png')],
  ['ours — First Person + right-drag: the PLAYER turned +96° (12 × 8°), orbit 0', join(V, 'core18baaaa/ours-core18baaaa-inhead-after-drag.png')],
  ['ours — Target In View, melee, player turned 90° away: view yaw −75.0° = target bearing −75°', join(V, 'core18baaaa/ours-core18baaaa-tracking.png')],
  ['ours — same with Target In View off: back behind the player (view yaw 15°)', join(V, 'core18baaaa/ours-core18baaaa-tracking-off.png')],
];
const img = (p: string) => `data:image/${p.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(p).toString('base64')}`;
const html = `<body style="margin:0;background:#111;font:16px sans-serif;color:#eee;display:grid;grid-template-columns:800px 800px;gap:4px">
${panes.map(([l, p]) => `<div><div style="padding:4px">${l}</div><img src="${img(p)}" style="width:800px;height:450px;display:block"></div>`).join('')}</body>`;
const browser = await chromium.launch(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const page = await browser.newPage({ viewport: { width: 1604, height: 1440 } });
await page.setContent(html);
await page.screenshot({ path: join(V, 'core18baaaa/sbs-core18baaaa.png'), fullPage: true });
await browser.close();
