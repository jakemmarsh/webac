/**
 * hitch-ab — compare tools/hitch-probe.ts `--run` outputs (PERF.run-hitches, 2026-11-15).
 *
 *   npx tsx tools/hitch-ab.ts A=verification/perf/hitch-*-ab-base-*.json B=verification/perf/hitch-*-ab-fix-*.json
 *     Per phase: mean ± sd over each side's runs of long-task ms/min, worst task, frame mean / p95,
 *     frameStep mean and its render phase, and B's change against A.
 *   npx tsx tools/hitch-ab.ts --detail <file.json> [--top 40]
 *     One run: each phase's frameStep split, self time by area and the top inclusive functions (ms/min).
 *
 * Globs are expanded by the shell; a side takes every file named after `A=` / `B=` up to the next side.
 */
import { readFileSync } from 'node:fs';

interface Summary {
  phase: string; secs: number; throttle: number; longTaskMsPerMin: number; worstTaskMs: number; tasksOver100: number;
  frameMean: number; frameP95: number; frameStepMean: number; frameStepP95: number; frameStepPhases: Record<string, number>;
  wholeByAreaMsPerMin: Record<string, number>; wholeInclTop: string[]; wholeSelfTop: string[]; longTaskInclTop: string[];
}
const args = process.argv.slice(2);
const load = (f: string) => (JSON.parse(readFileSync(f, 'utf8')) as { summaries: Summary[] }).summaries;

if (args[0] === '--detail') {
  const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : 40;
  for (const s of load(args[1])) {
    console.log(`\n== ${s.phase} @${s.throttle}x  longTask ${s.longTaskMsPerMin} ms/min, worst ${s.worstTaskMs}, frame mean ${s.frameMean} p95 ${s.frameP95}, frameStep ${s.frameStepMean}`);
    console.log('  frameStep phases:', JSON.stringify(s.frameStepPhases));
    console.log('  by area (ms/min):', JSON.stringify(s.wholeByAreaMsPerMin));
    console.log('  inclusive (ms/min):'); for (const l of s.wholeInclTop.slice(0, top)) console.log('   ', l);
    console.log('  self (ms/min):'); for (const l of s.wholeSelfTop.slice(0, Math.min(top, 25))) console.log('   ', l);
  }
  process.exit(0);
}

const sides = new Map<string, string[]>();
let cur = '';
for (const a of args) {
  const m = /^([A-Za-z]\w*)=(.*)$/.exec(a);
  if (m) { cur = m[1]; sides.set(cur, []); if (m[2]) sides.get(cur)!.push(m[2]); } else if (cur) sides.get(cur)!.push(a);
}
const METRICS: Array<[string, (s: Summary) => number]> = [
  ['longTask ms/min', (s) => s.longTaskMsPerMin], ['worst task', (s) => s.worstTaskMs], ['tasks >=100', (s) => s.tasksOver100],
  ['frame mean', (s) => s.frameMean], ['frame p95', (s) => s.frameP95], ['frameStep mean', (s) => s.frameStepMean],
  ['frameStep p95', (s) => s.frameStepP95], ['render phase', (s) => s.frameStepPhases.render ?? 0],
];
const stat = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, v.length - 1)); return { m, sd }; };
const names = [...sides.keys()];
const runs = new Map(names.map((n) => [n, sides.get(n)!.map(load)]));
const phases = [...new Set([...runs.values()].flat(2).map((s) => s.phase.replace(/^[^:]*:/, '')))];
for (const ph of phases) {
  console.log(`\n### ${ph}   (${names.map((n) => `${n}: ${runs.get(n)!.length} runs`).join(', ')})`);
  console.log(`${'metric'.padEnd(16)} ${names.map((n) => n.padStart(18)).join(' ')}   ${names.length > 1 ? `${names[1]} vs ${names[0]}` : ''}`);
  for (const [label, get] of METRICS) {
    const cols = names.map((n) => stat(runs.get(n)!.map((r) => r.find((s) => s.phase.endsWith(':' + ph))).filter((s): s is Summary => !!s).map(get)));
    const d = names.length > 1 && cols[0].m ? `${(((cols[1].m - cols[0].m) / cols[0].m) * 100).toFixed(1)}%` : '';
    console.log(`${label.padEnd(16)} ${cols.map((c) => `${c.m.toFixed(1)} ± ${c.sd.toFixed(1)}`.padStart(18)).join(' ')}   ${d}`);
  }
}
