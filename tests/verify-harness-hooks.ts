/**
 * Harness hooks (OPS.ci-and-hooks-gaps, 2026-09-26), driven for real against
 * throwaway git repos:
 *   - tools/hooks/pre-commit-check.sh (Claude PreToolUse on Bash) now sees a
 *     `git commit` anywhere in a chained command, refuses `git add … && git
 *     commit` (it runs before the command, so the add hasn't happened), checks
 *     the `git -C <dir>` target, and counts `commit -a` modifications;
 *   - tools/githooks/pre-push no longer loses the "touches TypeScript" signal
 *     to SIGPIPE on a big diff under pipefail;
 *   - tools/lockfile-drift.mjs (ci-local.sh) tells an in-sync node_modules
 *     from a drifted one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { lockfileDrift } from '../tools/lockfile-drift.mjs';

const ROOT = resolve(__dirname, '..');
const PRECOMMIT = join(ROOT, 'tools', 'hooks', 'pre-commit-check.sh');
const PREPUSH = join(ROOT, 'tools', 'githooks', 'pre-push');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  // No background auto-gc/maintenance racing the temp-dir cleanup.
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harness-hooks-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
}
function write(repo: string, rel: string, body: string) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), body);
}
function newRepo(name = 'repo') {
  const repo = join(dir, name);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'README.md', 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

/** Run the PreToolUse hook as Claude Code would: JSON on stdin, cwd = session cwd. */
function preCommit(command: string, cwd: string) {
  const marker = join(dir, 'build-ran');
  rmSync(marker, { force: true });
  const r = spawnSync('bash', [PRECOMMIT], {
    cwd, input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ACJS_PRECOMMIT_BUILD: `touch '${marker}'` },
  });
  return { code: r.status, err: r.stderr, built: existsSync(marker) };
}

// The Claude-harness hooks stay out of the public mirror (tools/public-export-lib.mjs),
// so a public checkout skips this block; the git hooks below are public and run everywhere.
describe.skipIf(!existsSync(PRECOMMIT))('pre-commit-check.sh: which commands it intercepts', () => {
  it('ignores non-commit commands and "git commit" inside a quoted string', () => {
    const repo = newRepo();
    for (const cmd of ['git status', 'ls && git log', 'echo "git commit -m x"', 'git commit-tree abc']) {
      const r = preCommit(cmd, repo);
      expect([cmd, r.code, r.built]).toEqual([cmd, 0, false]);
    }
  });
  it('ignores a chained add-and-commit that only appears INSIDE a quoted script argument', () => {
    // 2026-09-26: a `node -e '…'` script whose string literal mentioned
    // "git add … && git commit …" was blocked as a commit.
    const repo = newRepo();
    write(repo, 'packages/a/src/x.ts', 'export const x = 1;\n');
    git(repo, 'add', 'packages/a/src/x.ts');
    const add = ['git', 'add'].join(' ');
    const commit = ['git', 'commit'].join(' ');
    for (const cmd of [
      `node -e 'const s = "${add} x && ${commit} -m y"; console.log(s)'`,
      `node -e '\nconst p = "rule: ${add} … && ${commit} …";\n'`,
      `echo "${add} x; ${commit} -m y"`,
    ]) {
      const r = preCommit(cmd, repo);
      expect([cmd, r.code, r.built]).toEqual([cmd, 0, false]);
    }
    // A real commit whose MESSAGE mentions the pattern is still a commit (and
    // is judged on what is staged — here packages/ without tests/).
    const r = preCommit(`${commit} -m "note: ${add} && ${commit} are separate"`, repo);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no test files in tests\//);
  });
  it('intercepts a commit chained after && / ; / ||, not only at the start', () => {
    const repo = newRepo();
    write(repo, 'packages/a/src/x.ts', 'export const x = 1;\n');
    git(repo, 'add', 'packages/a/src/x.ts');
    for (const cmd of ['git commit -m x', 'git status && git commit -m x', 'cd . ; git commit -m x', 'false || git commit -m x', 'GIT_EDITOR=true git commit -m x']) {
      const r = preCommit(cmd, repo);
      expect([cmd, r.code]).toEqual([cmd, 2]);
      expect(r.built).toBe(true);
      expect(r.err).toMatch(/no test files in tests\//);
    }
  });
  it('refuses `git add … && git commit` in one call (the add has not happened when the hook runs)', () => {
    const repo = newRepo();
    write(repo, 'packages/a/src/x.ts', 'export const x = 1;\n');
    const r = preCommit('git add packages/a/src/x.ts && git commit -m x', repo);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/stages files AND commits in one call/);
    expect(r.err).toMatch(/separate call/);
    expect(preCommit('git -C . add -A; git commit -m x', repo).code).toBe(2);
  });
  it('checks the `git -C <dir>` target repo, not the cwd', () => {
    const repo = newRepo();
    const other = newRepo('other');
    write(repo, 'packages/a/src/x.ts', 'export const x = 1;\n');
    git(repo, 'add', 'packages/a/src/x.ts');
    expect(preCommit(`git -C ${repo} commit -m x`, other).code).toBe(2);
    expect(preCommit('git commit -m x', other).code).toBe(0); // other has nothing staged
  });
  it('counts `commit -a` / `-am` modifications as staged', () => {
    const repo = newRepo();
    write(repo, 'packages/a/src/x.ts', 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'add x');
    write(repo, 'packages/a/src/x.ts', 'export const x = 2;\n');
    expect(preCommit('git commit -m x', repo).code).toBe(0); // nothing staged
    expect(preCommit('git commit -am x', repo).code).toBe(2);
    expect(preCommit('git commit --all -m x', repo).code).toBe(2);
    expect(preCommit('git commit -am x [skip-tests]', repo).err).toMatch(/progress\.md not staged/);
  });
  it('a claim commit (tasks.json only) needs no progress.md entry', () => {
    const repo = newRepo();
    write(repo, 'tasks.json', '{"tasks":[{"id":"A","status":"in_progress"}]}');
    git(repo, 'add', 'tasks.json');
    const r = preCommit('git commit -m "A: claim [skip-tests]"', repo);
    expect(r.code).toBe(0);
  });
});

describe('githooks/pre-push: TypeScript detection survives big diffs', () => {
  function prePush(repo: string, lines: string) {
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const marker = join(dir, 'tsc-ran');
    rmSync(marker, { force: true });
    writeFileSync(join(bin, 'npx'), `#!/bin/bash\ntouch '${marker}'\nexit 0\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    const r = spawnSync('bash', [PREPUSH], { cwd: repo, input: lines, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` } });
    return { code: r.status, tsc: existsSync(marker), err: r.stderr };
  }
  it('runs tsc when a pushed commit with thousands of files includes a .ts (the SIGPIPE case)', () => {
    const repo = newRepo();
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    // The .ts sorts FIRST so `grep -q` matches immediately and would close the pipe on git.
    write(repo, 'aaa/first.ts', 'export {};\n');
    // ~1500 x ~120-byte names = ~180 KB of diff output, well past the 64 KB pipe buffer.
    for (let i = 0; i < 1500; i++) write(repo, `zz/f${String(i).padStart(5, '0')}-${'x'.repeat(110)}.txt`, `${i}\n`);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'big');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const r = prePush(repo, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(r.code).toBe(0);
    expect(r.tsc).toBe(true);
  });
  it('skips tsc for a docs-only push', () => {
    const repo = newRepo();
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    write(repo, 'docs/x.md', 'y\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'docs');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const r = prePush(repo, `refs/heads/main ${head} refs/heads/main ${base}\n`);
    expect(r.code).toBe(0);
    expect(r.tsc).toBe(false);
  });
});

describe('lockfile-drift (tools/ci-local.sh dependency check)', () => {
  const lock = {
    packages: {
      '': { name: 'acjs' },
      'node_modules/a': { version: '1.0.0', resolved: 'https://r/a-1.0.0.tgz' },
      'node_modules/@esbuild/linux-x64': { version: '0.21.5', optional: true },
      'node_modules/@ac/shared': { resolved: 'packages/shared', link: true },
    },
  };
  const hidden = {
    packages: {
      'node_modules/a': { version: '1.0.0', resolved: 'https://r/a-1.0.0.tgz' },
      'node_modules/@ac/shared': { resolved: 'packages/shared', link: true },
    },
  };
  it('in sync: a missing optional platform binary and the root entry are not drift', () => {
    expect(lockfileDrift(lock, hidden)).toEqual([]);
  });
  it('reports a version bump, a missing required dep, and an extraneous install', () => {
    const bumped = structuredClone(lock);
    bumped.packages['node_modules/a'] = { version: '1.1.0', resolved: 'https://r/a-1.1.0.tgz' };
    (bumped.packages as Record<string, unknown>)['node_modules/b'] = { version: '2.0.0' };
    const extra = structuredClone(hidden);
    (extra.packages as Record<string, unknown>)['node_modules/old'] = { version: '0.1.0' };
    expect(lockfileDrift(bumped, extra)).toEqual([
      'node_modules/a: version 1.0.0 installed, lockfile wants 1.1.0',
      'missing node_modules/b@2.0.0',
      'extraneous node_modules/old@0.1.0',
    ]);
  });
});
