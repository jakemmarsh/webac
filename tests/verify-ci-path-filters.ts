/**
 * .github/workflows/ci.yml path filters (OPS.ci-and-hooks-gaps): GitHub
 * documents `!` negation only for `paths` (not `paths-ignore`), so the
 * filters moved to the `paths` form. tools/ci-path-filter-lib.mjs evaluates
 * the committed lists with GitHub's semantics (last matching pattern wins);
 * this checks they select exactly the set the old `paths-ignore` list meant.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { fileTriggers, globToRegExp, loadCiFilters, pushTriggers } from '../tools/ci-path-filter-lib.mjs';

/** The intent of the pre-2026-09-26 `paths-ignore` list, stated as a predicate. */
function intendedIgnore(file: string): boolean {
  if (file === 'verification/texture-index.json' || file === 'verification/scorecard.json') return false;
  return /\.md$/.test(file) || file === 'tasks.json' || /^(docs|\.claude|reference)\//.test(file)
    || /^verification\/(playtest|perf|panel-specs)\//.test(file)
    || /^verification\/.*\.(png|json)$/.test(file)
    || file === 'LICENSE' || file === '.gitignore';
}

const SAMPLES = [
  'packages/renderer/package.json', 'packages/renderer/index.html', 'tests/verify-scorecard.ts', 'tools/task-status.mjs',
  'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'services/ws-tcp-bridge/src/bridge.ts', 'tsconfig.json',
  'vite.config.ts', 'tools/githooks/pre-push',
  'README.md', 'progress.md', 'packages/renderer/README.md', 'tasks.json', 'docs/remote-agent-ops.md',
  'docs/images/x.png', '.claude/skills/work/SKILL.md', '.claude/settings.local.json',
  'verification/playtest/run1/notes.txt', 'verification/perf/perf-2026.json', 'verification/panel-specs/inv.md',
  'verification/captures/inv.png', 'verification/foo.png', 'verification/sub/dir/x.json', 'verification/other.json',
  'verification/texture-index.json', 'verification/scorecard.json', 'verification/some-script.ts',
  'verification/captures/notes.txt', 'reference/ACE/Source/ACE.Server/Program.cs', 'LICENSE', '.gitignore', 'packages/x/.gitignore',
];

describe('ci.yml path filters', () => {
  let f: ReturnType<typeof loadCiFilters>;
  beforeAll(() => { f = loadCiFilters(); });

  it('uses the documented `paths` form (no `!` inside paths-ignore)', () => {
    expect(f.yml).not.toMatch(/paths-ignore:/);
    expect(f.push?.[0]).toBe('**');
  });
  it('push and pull_request filter identically', () => {
    expect(f.pull_request).toEqual(f.push);
  });
  it('selects exactly the intended set: code/config run CI; backlog, logs, docs, captures do not; the two test-read JSONs do', () => {
    const push = f.push!;
    for (const s of SAMPLES) expect([s, fileTriggers(push, s)]).toEqual([s, !intendedIgnore(s)]);
    expect(fileTriggers(push, 'verification/scorecard.json')).toBe(true);
    expect(fileTriggers(push, 'verification/texture-index.json')).toBe(true);
    expect(fileTriggers(push, 'progress.md')).toBe(false);
  });
  it('a push runs CI iff at least one of its files triggers', () => {
    const push = f.push!;
    expect(pushTriggers(push, ['tasks.json', 'progress.md'])).toBe(false); // a claim commit
    expect(pushTriggers(push, ['tasks.json', 'progress.md', 'tools/archive-progress.mjs'])).toBe(true);
    expect(pushTriggers(push, ['verification/perf/perf-x.json'])).toBe(false); // the nightly gpu-perf commit
  });
  it('the glob translation follows GitHub: ** spans dirs, **/ may be empty, * stays in a segment', () => {
    expect(globToRegExp('**.md').test('a/b/c.md')).toBe(true);
    expect(globToRegExp('verification/**/*.json').test('verification/x.json')).toBe(true);
    expect(globToRegExp('verification/**/*.json').test('verification/a/b/x.json')).toBe(true);
    expect(globToRegExp('docs/*').test('docs/a/b')).toBe(false);
  });
});
