/**
 * live-gate-scope — what the live gate's fast tier plays for a diff (tools/lib/live-gate-scope.ts holds the table).
 *
 *   npx tsx tools/live-gate-scope.ts --base <ref> [--head <ref>] [--explain]
 *   npx tsx tools/live-gate-scope.ts --paths a.ts,b.ts [--explain]      # a hypothetical diff
 *
 * Prints tab-separated lines tools/live-gate.sh reads:
 *   areas      smoke,inventory,…
 *   files      <changed path count>
 *   steps-<era>  <comma-separated play-through --only ids for that era>   (eor, classicace-customdm, ac1999-retail)
 *   captures   <space-separated screen-regression capture names>
 * --explain adds one `path <file> <areas>` line per changed file.
 */
import { execFileSync } from 'node:child_process';
import { ERA_PLANS, playthroughSteps } from './lib/playthrough.ts';
import { regressionSteps, withRegressionSteps } from './lib/playthrough-regressions.ts';
import { scopeFor, stepsForEra } from './lib/live-gate-scope.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
const base = flag('--base');
const head = flag('--head') ?? 'HEAD';
const paths = flag('--paths');
if (!base && paths === undefined) { console.error('usage: live-gate-scope.ts --base <ref> [--head <ref>] [--explain] | --paths a,b'); process.exit(2); }

const changed = paths !== undefined
  ? paths.split(',').map((s) => s.trim()).filter(Boolean)
  : execFileSync('git', ['diff', '--name-only', `${base}..${head}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
const scope = scopeFor(changed);
const out: string[] = [`areas\t${scope.areas.join(',')}`, `files\t${changed.length}`];
for (const era of Object.values(ERA_PLANS)) {
  // The gate runs the play-through without --admin: the same plan the tool builds then.
  const planIds = withRegressionSteps(playthroughSteps(era), regressionSteps(era)).map((s) => s.id);
  out.push(`steps-${era.key}\t${stepsForEra(scope.steps, planIds).join(',')}`);
}
out.push(`captures\t${scope.captures.join(' ')}`);
if (args.includes('--explain')) for (const b of scope.byPath) out.push(`path\t${b.path}\t${b.areas.join(',')}`);
console.log(out.join('\n'));
