/**
 * CORE.17.h.g.c.b — whole-screen harness scenes side-by-side: retail refs |
 * the pre-change build (verification/core17hgc/after-*, main @ fa91f6b) |
 * this build (verification/core17hgcb/after-*, from capture-ui-screens.ts --scenes).
 * Usage: npx tsx tools/compose-core17hgcb-scenes.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
const REPO = '/home/user/acjs';
const OUT = `${REPO}/verification/core17hgcb`;
const du = (f: string) => `data:image/${f.endsWith('.jpg') ? 'jpeg' : 'png'};base64,${readFileSync(f).toString('base64')}`;
const cell = (f: string, label: string, w = 520) => existsSync(f) ? `<div style="display:flex;flex-direction:column;gap:4px"><div style="color:#ffd;max-width:${w}px">${label}</div><img src="${du(f)}" style="width:${w}px;border:1px solid #444"/></div>` : '';
const rows = [
  ['world-town-day (Holtburg noon, yaw 0)', ['rawg_07.jpg', 'rawg_08.jpg'], `${REPO}/verification/core17hgc/after-world-town-day.png`],
  ['world-town-day-alt (yaw 2.4)', ['rawg_08.jpg', 'shoushi-live.jpg'], `${REPO}/verification/core17hgc/after-world-town-day.png`],
  ['world-dungeon (Training Academy 0x86020115)', ['rawg_04.jpg', 'rawg_09.jpg'], `${REPO}/verification/core17hgc/after-world-dungeon.png`],
] as const;
const names = ['world-town-day', 'world-town-day-alt', 'world-dungeon'];
const html = `<!doctype html><html><body style="margin:0;background:#1a1a1a;color:#eee;font:13px monospace;padding:10px">
<h1 style="font-size:14px">CORE.17.h.g.c.b — whole-screen harness scenes (capture-ui-screens.ts --scenes, SwiftShader): retail refs | main @ fa91f6b (pre-change build, from verification/core17hgc) | this build (detail pass ON by default)</h1>
${rows.map(([title, refs, before], i) => `<h2 style="font-size:13px;color:#9cf">${title}</h2><div style="display:flex;gap:10px;flex-wrap:wrap">
  ${refs.map(r => cell(`${REPO}/reference/images/hud/${r}`, `retail ${r}`, 380)).join('')}
  ${cell(before, i === 1 ? 'BEFORE — no pre-change capture of this yaw exists; world-town-day (yaw 0) shown for the same build' : 'BEFORE (main @ fa91f6b)')}
  ${cell(`${OUT}/after-${names[i]}.png`, 'AFTER (this build, pass ON)')}
</div>`).join('')}
</body></html>`;
async function main() {
const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1900, height: 1000 } });
await p.setContent(html, { waitUntil: 'load' });
await p.waitForTimeout(600);
await p.screenshot({ path: `${OUT}/core17hgcb-scenes-sidebyside.png`, fullPage: true });
await b.close();
console.log("wrote scenes sheet");
}
main().catch(e => { console.error(e); process.exit(1); });
