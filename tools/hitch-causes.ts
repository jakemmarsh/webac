/**
 * hitch-causes — the ranked cause table of docs/perf-pass-2026-11-15.md from tools/hitch-probe.ts `--run`
 * outputs: for each run file and phase, main-thread ms per minute (inclusive) of each named cause, plus the
 * phase's long-task ms/min and worst task. A cause is the inclusive time of its entry function; the causes
 * are disjoint subtrees of frameStep except where noted.
 *   npx tsx tools/hitch-causes.ts verification/perf/hitch-…json [more.json …] [--phase run|steady|arrive]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const CAUSES: Array<[string, RegExp]> = [
  ['three.js draw list + submission (renderScene)', /^renderScene deps\/three/],
  ['three.js cull / list build (projectObject)', /^projectObject deps\/three/],
  ['scene-graph matrices (updateMatrixWorldSkippingHidden)', /^updateMatrixWorldSkippingHidden /],
  ['camera boom collision (surfaceViewerDistance)', /^surfaceViewerDistance /],
  ['hover find under cursor (runHoverFind)', /^runHoverFind /],
  ['creature / NPC animation (updateAnimations)', /^updateAnimations src\/world\/ServerObjectManager/],
  ['degrade LOD (DegradeLod.updateParts)', /^updateParts src\/models\/DegradeLod/],
  ['DAT light pool (DatLightBudget.update)', /^update src\/effects\/DatLightBudget/],
  ['particles / spell effects (SpellEffects.update)', /^update src\/effects\/SpellEffects/],
  ['player movement + collision (stepPlayerMovement)', /^stepPlayerMovement /],
  ['HUD per frame (GameUI.updateHUD)', /^updateHUD src\/ui\/GameUI/],
  ['dungeon cell streaming (DungeonRenderer.updateStream)', /^updateStream src\/world\/DungeonRenderer/],
  ['landblock object streaming (streamAround / pump)', /^(streamAround|pump) src\/world\/LandblockObjectStreamer/],
  ['terrain rebuild on block crossing (TerrainRenderer.update)', /^update src\/terrain\/TerrainRenderer/],
  ['server messages (onSessionEvent)', /^onSessionEvent /],
  ['native / browser (program)', /^\(program\) /],
  ['garbage collection', /^\(garbage collector\) /],
];

const args = process.argv.slice(2);
const phaseArg = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : null;
const files = args.filter((a, i) => a.endsWith('.json') && args[i - 1] !== '--phase');
interface Summary { phase: string; throttle: number; longTaskMsPerMin: number; worstTaskMs: number; frameMean: number; frameP95: number; frameStepMean: number; wholeInclTop: string[]; wholeSelfTop: string[]; longTaskInclTop: string[] }
for (const f of files) {
  const { summaries } = JSON.parse(readFileSync(f, 'utf8')) as { summaries: Summary[] };
  for (const s of summaries) {
    if (phaseArg && !s.phase.endsWith(':' + phaseArg)) continue;
    const parse = (lines: string[]) => lines.map((l) => { const m = /^\s*(\d+) ms\s+(.*)$/.exec(l); return m ? { ms: Number(m[1]), fn: m[2] } : null; }).filter((x): x is { ms: number; fn: string } => !!x);
    const incl = parse([...s.wholeInclTop, ...s.wholeSelfTop]);
    const lt = parse(s.longTaskInclTop);
    console.log(`\n${basename(f)}  ${s.phase} @${s.throttle}x — long tasks ${s.longTaskMsPerMin} ms/min, worst ${s.worstTaskMs} ms, frame mean ${s.frameMean} / p95 ${s.frameP95}, frameStep ${s.frameStepMean}`);
    const rows = CAUSES.map(([name, re]) => ({ name, ms: Math.max(0, ...incl.filter((x) => re.test(x.fn)).map((x) => x.ms)), lt: Math.max(0, ...lt.filter((x) => re.test(x.fn)).map((x) => x.ms)) }));
    rows.sort((a, b) => b.ms - a.ms);
    for (const r of rows) console.log(`  ${String(r.ms || '<top').padStart(6)} ms/min  ${String(r.lt || '-').padStart(6)} in long tasks  ${r.name}`);
  }
}
