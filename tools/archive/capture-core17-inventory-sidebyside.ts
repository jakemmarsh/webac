/**
 * CORE.17.l/.m/.n/.o/.p — side-by-side evidence for the inventory panel.
 *
 * Composes (no browser driving — the live captures come from
 * `npx tsx tools/capture-ui-screens.ts --scenes hud-inventory-over-world`,
 * saved as verification/core17-inventory/{before,after}-hud-inventory-over-world.png):
 *
 *   core17-inventory-panel-sidebyside.png
 *     reference/images/hud/inventory-panel.jpg (ToD-era paperdoll crop —
 *       the audit's "retail"; WRONG-ERA for slot chrome, valid for the
 *       figure framing + slot positions)
 *     | DAT ground truth: the EoL slot tiles dumped from portal.dat
 *       (tools/dump-ui-texture-pngs.ts) laid out at their 0x21000024
 *       positions, plus the 0x10000367 scrollbar widget art
 *     | ours BEFORE (3x) | ours AFTER (3x)
 *
 *   core17-inventory-fullscreen-sidebyside.png
 *     ours before | ours after — whole screens, so the panel's footprint
 *     against the radar/toolbar dock is judged as a scene.
 *
 * Ours (1568x775 capture, 1024x768 HUD at 1.0): the docked panel is at
 * x 1266..1568, y 140..675.
 *
 * Usage: npx tsx tools/capture-core17-inventory-sidebyside.ts [texDir] [extraCapture [extraLabel]]
 *   texDir = a directory holding 0x06000f68.png … (defaults to
 *   verification/core17-inventory/tiles, produced with
 *   `npx tsx tools/dump-ui-texture-pngs.ts <ids> verification/core17-inventory/tiles`).
 *   extraCapture = an additional --scenes hud-inventory-over-world capture
 *   (same 1568x775 geometry) appended as a third "ours" cell — used for the
 *   closing-cycle re-verification of the pushed state.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17-inventory');
const TOD_REF = join(REPO, 'reference/images/hud/inventory-panel.jpg');
const BEFORE = join(OUT, 'before-hud-inventory-over-world.png');
const AFTER = join(OUT, 'after-hud-inventory-over-world.png');
const TEX_DIR = process.argv[2] && process.argv[2] !== '-' ? resolve(process.argv[2]) : join(OUT, 'tiles');
const EXTRA = process.argv[3] ? resolve(process.argv[3]) : null;
const EXTRA_LABEL = process.argv[4] ?? 'ours RE-VERIFIED (3x)';
const ZOOM = 3;

/** Layout 0x21000024 flank slots (x, y) + their template empty-state tile. */
const SLOTS: Array<[number, number, number]> = [
  [8, 8, 0x06000f68], [8, 44, 0x06006a6c], [8, 80, 0x06000f6a], [8, 116, 0x06000f6b], [8, 172, 0x06000f6c],
  [126, 8, 0x06006bef], [158, 8, 0x06006bf0], [190, 8, 0x06006bf1],
  [192, 44, 0x0600708f], [192, 80, 0x060032c5], [192, 116, 0x060032c4],
  [156, 80, 0x06000f5d], [156, 116, 0x06000f5a], [156, 172, 0x06000f66], [190, 172, 0x06000f5e],
];
const WIDGET = { track: 0x06004c5f, up: 0x06004c69, down: 0x06004c6c, thumb: [0x06004c60, 0x06004c63, 0x06004c66] };
const WRONG = { track: 0x06004d33, thumb: 0x06004d34, up: 0x06004d35, down: 0x06004d36 };

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number; zoom?: number }

const PANELS: Panel[] = [
  { file: BEFORE, label: 'ours BEFORE (3x)', x: 1266, y: 140, w: 302, h: 535 },
  { file: AFTER, label: 'ours AFTER (3x)', x: 1266, y: 140, w: 302, h: 535 },
  ...(EXTRA ? [{ file: EXTRA, label: EXTRA_LABEL, x: 1266, y: 140, w: 302, h: 535 }] : []),
];

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
const texUrl = (id: number): string | null => {
  const f = join(TEX_DIR, `0x${id.toString(16).padStart(8, '0')}.png`);
  return existsSync(f) ? dataUrl(f) : null;
};

function cropCell(p: Panel): string {
  const z = p.zoom ?? ZOOM;
  return `<div class="cell"><div class="lbl">${p.label}</div>
    <div class="clip" style="width:${p.w * z}px;height:${p.h * z}px">
      <img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * z}px;top:${-p.y * z}px;transform-origin:0 0;transform:scale(${z});image-rendering:pixelated"/>
    </div></div>`;
}

/** The DAT tiles at their 0x21000024 positions (3x), on the panel's dark ground. */
function datTruthCell(): string {
  const z = ZOOM;
  const tiles = SLOTS.map(([x, y, id]) => {
    const u = texUrl(id);
    return u ? `<img src="${u}" style="position:absolute;left:${x * z}px;top:${y * z}px;width:${32 * z}px;height:${32 * z}px;image-rendering:pixelated"/>` : '';
  }).join('');
  const bar = (x: number, t: number, u: number, d: number, th: number[], label: string) => {
    const tr = texUrl(t), up = texUrl(u), dn = texUrl(d);
    const thumb = th.map(texUrl);
    return `<div style="position:absolute;left:${x * z}px;top:${8 * z}px;width:${16 * z}px;height:${180 * z}px;${tr ? `background:url(${tr}) repeat-y;background-size:${16 * z}px auto;` : ''}image-rendering:pixelated">
      ${up ? `<img src="${up}" style="position:absolute;top:0;left:0;width:${16 * z}px;height:${16 * z}px;image-rendering:pixelated"/>` : ''}
      ${dn ? `<img src="${dn}" style="position:absolute;bottom:0;left:0;width:${16 * z}px;height:${16 * z}px;image-rendering:pixelated"/>` : ''}
      ${thumb[0] ? `<img src="${thumb[0]}" style="position:absolute;top:${16 * z}px;left:0;width:${16 * z}px;height:${3 * z}px"/>` : ''}
      ${thumb[1] ? `<img src="${thumb[1]}" style="position:absolute;top:${19 * z}px;left:0;width:${16 * z}px;height:${40 * z}px"/>` : ''}
      ${thumb[2] ? `<img src="${thumb[2]}" style="position:absolute;top:${59 * z}px;left:0;width:${16 * z}px;height:${3 * z}px"/>` : ''}
      <div class="sub" style="position:absolute;top:${184 * z}px;left:-${20 * z}px;width:${56 * z}px">${label}</div>
    </div>`;
  };
  return `<div class="cell"><div class="lbl">DAT ground truth — EoL tiles at their 0x21000024 slots (3x) + scrollbar widgets</div>
    <div class="clip" style="width:${300 * z}px;height:${214 * z}px;background:#1c1a17">
      ${tiles}
      ${bar(236, WIDGET.track, WIDGET.up, WIDGET.down, WIDGET.thumb, '0x10000367 (DAT base of 0x100001c7/cb)')}
      ${bar(272, WRONG.track, WRONG.up, WRONG.down, [WRONG.thumb], '0x100002dc (what we drew)')}
    </div></div>`;
}

async function main(): Promise<void> {
  for (const f of [TOD_REF, BEFORE, AFTER, ...(EXTRA ? [EXTRA] : [])]) {
    if (!existsSync(f)) throw new Error(`missing ${f}`);
  }
  const css = `<style>
    body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
    .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{color:#ffd;white-space:nowrap;max-width:900px;white-space:normal}
    .sub{color:#ccc;font-size:11px;text-align:center}
    .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
    .full img{display:block;width:1000px;height:auto;border:1px solid #444}
    h1{font-size:14px;margin:0 0 8px}
    p{max-width:1900px;color:#ccc;margin:0 0 8px}
  </style>`;
  const br = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await br.newPage({ viewport: { width: 2900, height: 1750 } });

  await page.setContent(`${css}<h1>CORE.17.l/.m/.n/.o/.p — inventory panel: ToD-era reference | DAT (EoL) ground truth | ours before | ours after</h1>
    <p>inventory-panel.jpg is the audit's "retail": its gold/tan slot chrome is the ToD-era art family (docs/era-determination.md) — the EoL DAT tiles in the second cell are what the retail EoL client draws (template layout 0x21000037 empty-state media). Valid from the ToD crop: the figure framed head-to-boot and the slot positions.</p>
    <div class="row">
      ${cropCell({ file: TOD_REF, label: 'reference/images/hud/inventory-panel.jpg (ToD era, 256x215 → 3x)', x: 0, y: 0, w: 256, h: 215 })}
      ${datTruthCell()}
    </div><div style="height:12px"></div>
    <div class="row">${PANELS.map(cropCell).join('')}</div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17-inventory-panel-sidebyside.png'), fullPage: true });

  await page.setContent(`${css}<h1>CORE.17 inventory — whole-screen: ours before | ours after (1568x775, docked panel between radar and toolbar)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">ours BEFORE</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img src="${dataUrl(AFTER)}"/></div>
      ${EXTRA ? `<div class="cell"><div class="lbl">${EXTRA_LABEL.replace(' (3x)', '')}</div><img src="${dataUrl(EXTRA)}"/></div>` : ''}
    </div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17-inventory-fullscreen-sidebyside.png'), fullPage: true });
  await br.close();
  console.log(`wrote ${join(OUT, 'core17-inventory-panel-sidebyside.png')} and core17-inventory-fullscreen-sidebyside.png`);
}

main().catch((e) => { console.error(e); process.exit(1); });
