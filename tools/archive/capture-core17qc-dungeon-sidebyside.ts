/**
 * CORE.17.q.c — side-by-side evidence for the new light-stone dungeon scene.
 *
 * The harness's only dungeon scene was the Training Academy cave
 * (0x86020115): no retail reference shows that set, and CORE.17.q's probe
 * frames of it were pixel-identical under every lighting change. The new
 * scenes land in the Holtburg Dungeon (0x01F6 — the tan cobble wall
 * 0x0800016f + beams 0x08000176 of rawg_04 / rawg_09) at noon and at
 * midnight.
 *
 * Composes (no browser driving — the frames come from
 * `npx tsx tools/capture-ui-screens.ts --scenes world-dungeon-stone
 * world-dungeon-stone-night` → verification/screens/scenes/, and
 * `npx tsx tools/probe-core17qc-holtburg-dungeon.ts` → verification/core17qc/):
 *
 *   core17qc-dungeon-sidebyside.png
 *     row 1: retail rawg_04 | retail rawg_09 | ours, the OLD cave scene
 *     row 2: ours world-dungeon-stone (noon) | ours world-dungeon-stone-night
 *     row 3: the probe — noon | midnight | sky ambient + viewer light off |
 *            DAT torches off, with the sampled region means
 *
 * Usage: npx tsx tools/capture-core17qc-dungeon-sidebyside.ts
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17qc');
const SCENES = join(REPO, 'verification', 'screens', 'scenes');
const REFS = join(REPO, 'reference', 'images', 'hud');
const DAY = join(SCENES, 'world-dungeon-stone.png');
const NIGHT = join(SCENES, 'world-dungeon-stone-night.png');
const CAVE = join(REPO, 'verification', 'core17q', 'after-world-dungeon.png');

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}
function cell(file: string, label: string, w = 760): string {
  if (!existsSync(file)) return `<div class="cell"><div class="lbl">${label}</div><div class="missing" style="width:${w}px">missing: ${file.replace(REPO + '/', '')}</div></div>`;
  return `<div class="cell"><div class="lbl">${label}</div><img style="width:${w}px" src="${dataUrl(file)}"/></div>`;
}

async function main(): Promise<void> {
  for (const f of [DAY, NIGHT]) if (!existsSync(f)) throw new Error(`missing ${f} — run capture-ui-screens.ts --scenes world-dungeon-stone world-dungeon-stone-night first`);
  const samplesFile = join(OUT, 'probe-samples.json');
  const samples = existsSync(samplesFile) ? JSON.parse(readFileSync(samplesFile, 'utf8')) : null;
  const fmt = (k: string) => samples?.results?.[k] ? Object.entries(samples.results[k] as Record<string, number[]>).map(([r, v]) => `${r} (${v.join(',')})`).join(' · ') : '';
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 } });
  const css = `<style>
    body{background:#111;color:#ddd;font:14px sans-serif;margin:12px}
    h1{font-size:16px;margin:0 0 8px}
    .row{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{font-size:13px;color:#ccc;max-width:760px}
    img{border:1px solid #444;display:block}
    .missing{height:120px;border:1px dashed #666;color:#888;padding:8px}
    .note{font-size:12px;color:#aaa;max-width:2300px;margin-bottom:10px}
  </style>`;
  await page.setContent(`${css}<h1>CORE.17.q.c — a light-stone torch-lit dungeon scene for the harness: the Holtburg Dungeon (0x01F6, the tan cobble set of the retail references) replaces the Academy cave as the lighting A/B scene; a midnight variant alongside</h1>
    <div class="note">Retail: rawg_04 / rawg_09 (1024x768 / 800x600 retail frames) — the tan cobble wall 0x0800016f, wood beams 0x08000176, the dark brick floor, wall torches. Ours: 1568x775 SwiftShader captures over the ACE stack (weather off, day group Sunny, time pinned), landing on the portal's own Destination 0x01F60289 (96.7, -10, 0) from the world DB, yaw 1.6. The cave scene (0x86020115) stays in the table; it has no retail reference and CORE.17.q's probes of it were pixel-identical under every lighting change.</div>
    <div class="row">
      ${cell(join(REFS, 'rawg_04.jpg'), 'retail rawg_04 — the tan cobble dungeon set, torch pools on the wall, beams')}
      ${cell(join(REFS, 'rawg_09.jpg'), 'retail rawg_09 — the same set, wall torch + beams')}
      ${cell(CAVE, 'ours — the OLD world-dungeon scene (Training Academy cave 0x86020115, CORE.17.q after-frame): dark cave texels, no retail reference')}
    </div>
    <div class="row">
      ${cell(DAY, 'ours — world-dungeon-stone (noon, Holtburg Dungeon 0x01F60289, yaw 1.6)')}
      ${cell(NIGHT, 'ours — world-dungeon-stone-night (midnight, same drop point): retail would read IDENTICAL — a sealed cell\'s ambient is the constant DUNGEON_LIGHT_MINIMUM 0.2 white (CellManager::ChangePosition @ 004559b0), filed CORE.17.q.d')}
    </div>
    <h1>the probe (tools/probe-core17qc-holtburg-dungeon.ts, yaw 0 at the drop point) — the scene shows a lighting delta the cave could not</h1>
    <div class="row">
      ${cell(join(OUT, 'probe-noon.png'), 'noon as-is: ' + fmt('noon_asis'), 560)}
      ${cell(join(OUT, 'probe-night.png'), 'midnight: ' + fmt('night'), 560)}
      ${cell(join(OUT, 'probe-noambient-noviewer.png'), 'sky ambient hidden + viewer light 0: ' + fmt('noon_skyAmbientHidden_viewer0'), 560)}
      ${cell(join(OUT, 'probe-nolights.png'), 'DAT torches off (ambient + viewer light only): ' + fmt('noon_datLightsOff_only'), 560)}
    </div>`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'core17qc-dungeon-sidebyside.png'), fullPage: true });
  console.log(`[core17qc] wrote ${join(OUT, 'core17qc-dungeon-sidebyside.png')}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
