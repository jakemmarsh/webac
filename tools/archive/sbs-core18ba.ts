/**
 * CORE.18.b.a — side-by-side: retail A/B frame | ours default | ours wheeled
 * fully in (stops at 0.6 m) | ours in the head (Numpad .). Half-scale 2x2.
 *
 *   npx tsx tools/sbs-core18ba.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V = join(ROOT, 'verification');
const panes: [string, string][] = [
  ['retail (EoL, same spot + heading)', join(V, 'retail-client/ab/retail-holtburg.png')],
  ['ours — default boom (CORE.18.b)', join(V, 'core18ba/ours-core18ba-default.png')],
  ['ours — wheel fully in: stops at 0.60 m (Closer refuses < 0.5)', join(V, 'core18ba/ours-core18ba-wheel-in-full.png')],
  ['ours — Numpad . (0x3a SetInHead): 0.18 m ahead of pivot, player hidden', join(V, 'core18ba/ours-core18ba-in-head.png')],
];
const img = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
const html = `<body style="margin:0;background:#111;font:16px sans-serif;color:#eee;display:grid;grid-template-columns:800px 800px;gap:4px">
${panes.map(([l, p]) => `<div><div style="padding:4px">${l}</div><img src="${img(p)}" style="width:800px;height:450px;display:block"></div>`).join('')}</body>`;
const browser = await chromium.launch(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
const page = await browser.newPage({ viewport: { width: 1604, height: 960 } });
await page.setContent(html);
await page.screenshot({ path: join(V, 'core18ba/sbs-core18ba.png'), fullPage: true });
await browser.close();
